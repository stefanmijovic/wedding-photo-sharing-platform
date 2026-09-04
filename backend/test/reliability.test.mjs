import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { PassThrough, Readable, Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { NonRetryableJobError, ProcessingQueue, migrateProcessingJobs } from "../dist/processing-queue.js";
import { configureSqliteReliability, isTransientSqliteError } from "../dist/reliability.js";
import { streamFileToResponse } from "../dist/stream-reliability.js";

const execFileAsync = promisify(execFile);
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function memoryQueue(options = {}) {
    const db = new Database(":memory:");
    migrateProcessingJobs(db);
    const order = [];
    const processors = {
        video_process: async (job) => { order.push(`video:${job.targetId}`); },
        voice_normalize: async (job) => { order.push(`voice:${job.targetId}`); },
        ...options.processors
    };
    const queue = new ProcessingQueue({ db, processors, retryDelaysMs: [1], idlePollMs: 10, workerErrorDelayMs: 5 });
    return { db, queue, order };
}

describe("Phase 1E SQLite reliability", () => {
    test("session/main helper postavlja WAL, NORMAL i busy_timeout=5000 bez schema izmene", () => {
        const db = new Database(":memory:");
        configureSqliteReliability(db);
        assert.equal(db.pragma("journal_mode", { simple: true }), "memory");
        assert.equal(db.pragma("synchronous", { simple: true }), 1);
        assert.equal(db.pragma("busy_timeout", { simple: true }), 5_000);
        assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), []);
        db.close();
    });

    test("file session DB dobija persistent WAL", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "wedding-session-pragma-"));
        const db = new Database(path.join(root, "sessions.sqlite"));
        configureSqliteReliability(db);
        assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
        assert.equal(db.pragma("synchronous", { simple: true }), 1);
        assert.equal(db.pragma("busy_timeout", { simple: true }), 5_000);
        db.close();
        await rm(root, { recursive: true, force: true });
    });

    test("samo SQLITE_BUSY/LOCKED porodica se klasifikuje transient", () => {
        for (const code of ["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED"]) {
            assert.equal(isTransientSqliteError({ code }), true);
        }
        for (const code of ["SQLITE_CONSTRAINT", "SQLITE_ERROR", "SQLITE_CORRUPT", "ENOENT"]) {
            assert.equal(isTransientSqliteError({ code }), false);
        }
    });
});

describe("Phase 1E queue priority and classification", () => {
    test("voice C ide pre queued video A/B/D, zatim video ostaje FIFO", async () => {
        const { db, queue, order } = memoryQueue();
        queue.enqueue("photo", 1, "video_process");
        queue.enqueue("photo", 2, "video_process");
        queue.enqueue("voice_message", 3, "voice_normalize");
        queue.enqueue("photo", 4, "video_process");
        while (await queue.processNext()) {}
        assert.deepEqual(order, ["voice:3", "video:1", "video:2", "video:4"]);
        db.close();
    });

    test("aktivan video se ne prekida; voice postaje tek sledeći posao", async () => {
        let releaseVideo;
        const gate = new Promise((resolve) => { releaseVideo = resolve; });
        const { db, queue, order } = memoryQueue({ processors: {
            video_process: async (job) => { order.push(`video:${job.targetId}:start`); await gate; order.push(`video:${job.targetId}:end`); },
            voice_normalize: async (job) => { order.push(`voice:${job.targetId}`); }
        } });
        queue.enqueue("photo", 1, "video_process");
        const active = queue.processNext();
        await new Promise((resolve) => setImmediate(resolve));
        queue.enqueue("voice_message", 2, "voice_normalize");
        assert.deepEqual(order, ["video:1:start"]);
        releaseVideo();
        await active;
        await queue.processNext();
        assert.deepEqual(order, ["video:1:start", "video:1:end", "voice:2"]);
        db.close();
    });

    test("delayed voice retry nije eligible pre available_at", async () => {
        const { db, queue, order } = memoryQueue();
        const voice = queue.enqueue("voice_message", 1, "voice_normalize");
        queue.enqueue("photo", 2, "video_process");
        db.prepare("UPDATE processing_jobs SET available_at=? WHERE id=?").run(new Date(Date.now() + 60_000).toISOString(), voice.id);
        await queue.processNext();
        assert.deepEqual(order, ["video:2"]);
        db.close();
    });

    test("unknown job failuje posle jednog attempta i ne blokira validan posao", async () => {
        const { db, queue, order } = memoryQueue();
        const unknown = queue.enqueue("photo", 1, "unknown_job");
        await queue.processNext();
        const failed = db.prepare("SELECT status,attempt_count FROM processing_jobs WHERE id=?").get(unknown.id);
        assert.deepEqual(failed, { status: "failed", attempt_count: 1 });
        queue.enqueue("photo", 2, "video_process");
        await queue.processNext();
        assert.deepEqual(order, ["video:2"]);
        db.close();
    });

    for (const [label, jobType] of [["video", "video_process"], ["voice", "voice_normalize"]]) {
        test(`missing original ${label} je non-retryable i worker nastavlja`, async () => {
            const { db, queue, order } = memoryQueue({ processors: {
                [jobType]: async () => { throw new NonRetryableJobError("Original ne postoji."); }
            } });
            const missing = queue.enqueue(label === "video" ? "photo" : "voice_message", 1, jobType);
            await queue.processNext();
            assert.deepEqual(db.prepare("SELECT status,attempt_count FROM processing_jobs WHERE id=?").get(missing.id), { status: "failed", attempt_count: 1 });
            queue.enqueue("photo", 2, "video_process");
            if (jobType === "video_process") {
                // Zameni kontrolisani processor samo za nastavak proverom drugog podržanog tipa.
                queue.enqueue("voice_message", 3, "voice_normalize");
                await queue.processNext();
                assert.deepEqual(order, ["voice:3"]);
            } else {
                await queue.processNext();
                assert.deepEqual(order, ["video:2"]);
            }
            db.close();
        });
    }

    test("ffmpeg/transient failure ostaje retryable", async () => {
        const { db, queue } = memoryQueue({ processors: { video_process: async () => { throw Object.assign(new Error("temporary ffmpeg"), { retryable: true }); } } });
        const job = queue.enqueue("photo", 1, "video_process", 4);
        await queue.processNext();
        assert.deepEqual(db.prepare("SELECT status,attempt_count FROM processing_jobs WHERE id=?").get(job.id), { status: "queued", attempt_count: 1 });
        db.close();
    });

    test("top-level claim error se loguje, čeka bounded delay i sledeća iteracija nastavlja", async () => {
        const { db, queue, order } = memoryQueue();
        queue.enqueue("photo", 1, "video_process");
        const originalClaim = queue.claimNext.bind(queue);
        let calls = 0;
        queue.claimNext = () => { calls += 1; if (calls === 1) throw Object.assign(new Error("locked"), { code: "SQLITE_BUSY" }); return originalClaim(); };
        const originalError = console.error;
        const logs = [];
        console.error = (...values) => logs.push(values.join(" "));
        try {
            queue.start();
            const deadline = Date.now() + 500;
            while (order.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
            await queue.stop();
        } finally {
            console.error = originalError;
        }
        assert.deepEqual(order, ["video:1"]);
        assert.ok(logs.some((line) => line.includes("worker iteration error=SQLITE_BUSY")));
        db.close();
    });
});

class MockResponse extends Writable {
    constructor() { super(); this.headersSent = false; this.statusCode = 200; this.body = null; this.destroyedWith = null; this.headers = new Map(); }
    _write(chunk, _encoding, callback) { this.headersSent = true; callback(); }
    setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }
    removeHeader(name) { this.headers.delete(name.toLowerCase()); }
    status(value) { this.statusCode = value; return this; }
    json(value) { this.body = value; this.end(); return this; }
    destroy(error) { this.destroyedWith = error; return super.destroy(); }
}

describe("Phase 1E stream reliability", () => {
    test("stream success prosleđuje sadržaj", async () => {
        const response = new MockResponse();
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        streamFileToResponse("unused", response, { createReadStream: () => Readable.from([Buffer.from("media")]) });
        await new Promise((resolve) => response.once("finish", resolve));
        assert.equal(response.destroyedWith == null, true);
    });

    test("failure pre headers vraća kontrolisan 404 bez unhandled error event-a", async () => {
        const response = new MockResponse();
        const stream = new PassThrough();
        streamFileToResponse("unused", response, { createReadStream: () => stream });
        stream.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(response.statusCode, 404);
        assert.equal(response.body.code, "MEDIA_NOT_FOUND");
    });

    test("failure posle headers destroy-uje response i proces ostaje živ", async () => {
        const response = new MockResponse();
        response.headersSent = true;
        const stream = new PassThrough();
        streamFileToResponse("unused", response, { createReadStream: () => stream });
        const failure = Object.assign(new Error("read failed"), { code: "EIO" });
        stream.emit("error", failure);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(response.destroyedWith, failure);
    });
});

async function startServer(extraEnv = {}) {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wedding-reliability-server-"));
    const child = spawn(process.execPath, ["dist/server.js"], {
        cwd: backendRoot,
        env: {
            ...process.env, NODE_ENV: "test", PORT: "0", TEST_DATA_ROOT: dataRoot,
            TEST_DISABLE_PROCESSING_WORKER: "1", TEST_SKIP_AI_MODERATION: "1", TEST_DB_BUSY_TIMEOUT_MS: "25",
            SESSION_SECRET: "test-session-secret-at-least-32-characters-long", ADMIN_EMAIL: "admin@example.test",
            ADMIN_PANEL_URL: "http://localhost/admin.html", DEFAULT_ADMIN_USERNAME: "test-admin",
            DEFAULT_ADMIN_PASSWORD: "test-password-at-least-12-characters",
            EVENT_UNLOCK_AT: "2020-10-10T08:00:00+02:00", WEDDING_AT: "2020-10-10T13:30:00+02:00", ...extraEnv
        }, stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`server timeout ${stdout} ${stderr}`)), 15_000);
        child.stdout.on("data", (chunk) => { stdout += chunk; const match = stdout.match(/Server radi na portu (\d+)/); if (match) { clearTimeout(timeout); resolve(Number(match[1])); } });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.once("exit", (code) => reject(new Error(`server exit ${code} ${stdout} ${stderr}`)));
    });
    return { dataRoot, baseUrl: `http://127.0.0.1:${port}`, stderr: () => stderr, async stop() { if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); } await rm(dataRoot, { recursive: true, force: true }); } };
}

describe("Phase 1E HTTP busy and email behavior", () => {
    test("locked like dobija 503 DB_TEMPORARILY_BUSY bez stack trace-a", async () => {
        const server = await startServer();
        const locker = new Database(path.join(server.dataRoot, "database.sqlite"));
        try {
            const inserted = locker.prepare("INSERT INTO photos (filename,original_url,thumb_url,status,uploaded_at,ai_score,ai_reason,media_type,web_url) VALUES ('busy.jpg','/uploads/original/busy.jpg','/uploads/thumbs/busy.jpg','approved',?,0,'','image','')").run(new Date().toISOString());
            locker.exec("BEGIN IMMEDIATE");
            const response = await fetch(`${server.baseUrl}/api/photos/${inserted.lastInsertRowid}/like`, {
                method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "reliability-client-1234" })
            });
            const text = await response.text();
            assert.equal(response.status, 503, text);
            assert.equal(response.headers.get("retry-after"), "2");
            assert.equal(JSON.parse(text).code, "DB_TEMPORARILY_BUSY");
            assert.doesNotMatch(text, /SQLITE|stack|\.ts:/i);
        } finally {
            try { locker.exec("ROLLBACK"); } catch {}
            locker.close();
            await server.stop();
        }
    });

    test("email failure ne menja validan video upload business result i loguje kontekst", async (context) => {
        try {
            await execFileAsync("ffmpeg", ["-version"]);
        } catch {
            context.skip("FFmpeg nije dostupan za generisanje izolovanog video fixture-a.");
            return;
        }
        const server = await startServer({ TEST_EMAIL_FAILURE: "1" });
        const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "wedding-email-video-"));
        const videoPath = path.join(fixtureRoot, "clip.mp4");
        try {
            await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=30", "-t", "0.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-y", videoPath]);
            const form = new FormData();
            form.append("photo", new Blob([await readFile(videoPath)], { type: "video/mp4" }), "clip.mp4");
            const response = await fetch(`${server.baseUrl}/api/upload/video`, { method: "POST", body: form });
            assert.equal(response.status, 200, await response.text());
            await new Promise((resolve) => setTimeout(resolve, 20));
            assert.match(server.stderr(), /EMAIL_NOTIFICATION_FAILED.*notification=pending_review.*mediaId=/);
        } finally {
            await server.stop();
            await rm(fixtureRoot, { recursive: true, force: true });
        }
    });
});
