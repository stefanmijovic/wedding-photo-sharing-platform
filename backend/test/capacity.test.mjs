import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import sharp from "sharp";
import {
    AdmissionController,
    CAPACITY_POLICY,
    CapacityAdmissionError,
    DiskCapacityProvider,
    GiB,
    classifyDiskState
} from "../dist/capacity.js";
import { ProcessingQueue, migrateProcessingJobs } from "../dist/processing-queue.js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakeStatfs(totalBytes, availableBytes) {
    return async () => ({ bsize: 1n, blocks: BigInt(totalBytes), bfree: BigInt(availableBytes), bavail: BigInt(availableBytes) });
}

function disk(total = 500 * GiB, available = 200 * GiB) {
    return new DiskCapacityProvider("/unused", fakeStatfs(total, available), 0);
}

function stats(overrides = {}) {
    return { queued: 0, processing: 0, failed: 0, oldestQueuedAgeMs: null, ...overrides };
}

describe("Phase 1D disk capacity provider", () => {
    test("healthy, percentage/absolute warning, reject, emergency i stroži uslov", () => {
        assert.equal(classifyDiskState(500 * GiB, 200 * GiB), "healthy");
        assert.equal(classifyDiskState(500 * GiB, 95 * GiB), "warning");
        assert.equal(classifyDiskState(200 * GiB, 39 * GiB), "warning");
        assert.equal(classifyDiskState(500 * GiB, 55 * GiB), "reject");
        assert.equal(classifyDiskState(200 * GiB, 24 * GiB), "reject");
        assert.equal(classifyDiskState(100 * GiB, 6 * GiB), "emergency");
        assert.equal(classifyDiskState(500 * GiB, 11 * GiB), "emergency");
        assert.equal(classifyDiskState(0, 0), "unknown");
    });

    test("cache sprečava ponovljen statfs dok ne istekne i force osvežava", async () => {
        let calls = 0;
        let now = 1_000;
        const provider = new DiskCapacityProvider("/unused", async () => {
            calls += 1;
            return fakeStatfs(500 * GiB, 200 * GiB)();
        }, 3_000, () => now);
        await provider.get();
        await provider.get();
        assert.equal(calls, 1);
        now += 3_001;
        await provider.get();
        assert.equal(calls, 2);
        await provider.get(true);
        assert.equal(calls, 3);
    });

    test("statfs failure je fail-safe unknown i odbija novi upload", async () => {
        const provider = new DiskCapacityProvider("/unused", async () => { throw new Error("statfs failed"); }, 0);
        assert.equal((await provider.get()).state, "unknown");
        const controller = new AdmissionController(provider, () => stats(), { warn() {}, info() {} });
        await assert.rejects(controller.acquire("video"), (error) => error instanceof CapacityAdmissionError && error.code === "CAPACITY_TEMPORARILY_UNAVAILABLE");
    });

    test("reservation koja prelazi reject prag se odbija", async () => {
        const controller = new AdmissionController(disk(500 * GiB, 29 * GiB), () => stats(), { warn() {}, info() {} });
        await assert.rejects(controller.acquire("video"), (error) => error.code === "LOW_DISK_SPACE");
    });
});

describe("Phase 1D admission slots i backlog", () => {
    test("image ima 2 active, 6 pending, zatim 503; release promoviše pending", async () => {
        const controller = new AdmissionController(disk(), () => stats(), { warn() {}, info() {} });
        const first = await controller.acquire("image");
        const second = await controller.acquire("image");
        const pending = Array.from({ length: 6 }, () => controller.acquire("image"));
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(controller.snapshot(), {
            activeImageUploads: 2, pendingImageUploads: 6, activeVideoUploads: 0, activeVoiceUploads: 0,
            reservedDiskBytes: 8 * CAPACITY_POLICY.imageReservationBytes
        });
        await assert.rejects(controller.acquire("image"), (error) => error.code === "IMAGE_PIPELINE_BUSY");
        first();
        const promoted = await pending[0];
        assert.equal(controller.snapshot().activeImageUploads, 2);
        promoted();
        second();
        for (let index = 1; index < pending.length; index += 1) (await pending[index])();
        assert.equal(controller.snapshot().activeImageUploads, 0);
        assert.equal(controller.snapshot().reservedDiskBytes, 0);
    });

    test("video max 2, voice max 4, idempotent release bez negative/over-release", async () => {
        const controller = new AdmissionController(disk(), () => stats(), { warn() {}, info() {} });
        const videos = [await controller.acquire("video"), await controller.acquire("video")];
        await assert.rejects(controller.acquire("video"), (error) => error.code === "VIDEO_QUEUE_BUSY");
        const voices = await Promise.all(Array.from({ length: 4 }, () => controller.acquire("voice")));
        await assert.rejects(controller.acquire("voice"), (error) => error.code === "VOICE_PIPELINE_BUSY");
        for (const release of [...videos, ...voices]) { release(); release(); }
        assert.equal(controller.snapshot().reservedDiskBytes, 0);
        assert.equal(controller.snapshot().activeVideoUploads, 0);
        assert.equal(controller.snapshot().activeVoiceUploads, 0);
    });

    test("exception/failure finally obrazac oslobađa slot; novi controller počinje čist", async () => {
        const controller = new AdmissionController(disk(), () => stats(), { warn() {}, info() {} });
        const release = await controller.acquire("voice");
        try { throw new Error("validation failure"); } catch {} finally { release(); }
        assert.equal(controller.snapshot().activeVoiceUploads, 0);
        assert.equal(new AdmissionController(disk(), () => stats()).snapshot().reservedDiskBytes, 0);
    });

    test("abort uklanja pending image i reservation bez leaked slot-a", async () => {
        const controller = new AdmissionController(disk(), () => stats(), { warn() {}, info() {} });
        const releases = [await controller.acquire("image"), await controller.acquire("image")];
        const abort = new AbortController();
        const waiting = controller.acquire("image", abort.signal);
        await new Promise((resolve) => setImmediate(resolve));
        abort.abort();
        await assert.rejects(waiting);
        assert.equal(controller.snapshot().pendingImageUploads, 0);
        releases.forEach((release) => release());
        assert.equal(controller.snapshot().reservedDiskBytes, 0);
    });
});

describe("Phase 1D video queue pressure", () => {
    for (const [label, queueStats, accepted] of [
        ["depth 0", stats({ queued: 0 }), true],
        ["depth 10 warning", stats({ queued: 10 }), true],
        ["depth 19", stats({ queued: 19 }), true],
        ["depth 20", stats({ queued: 20 }), false],
        ["oldest 30m warning", stats({ oldestQueuedAgeMs: 30 * 60_000 }), true],
        ["oldest over 2h", stats({ oldestQueuedAgeMs: 2 * 60 * 60_000 + 1 }), false]
    ]) {
        test(label, async () => {
            const controller = new AdmissionController(disk(), () => queueStats, { warn() {}, info() {} });
            if (accepted) (await controller.acquire("video"))();
            else await assert.rejects(controller.acquire("video"), (error) => error.code === "VIDEO_QUEUE_BUSY");
        });
    }

    test("video backlog sam po sebi ne blokira voice", async () => {
        const controller = new AdmissionController(disk(), () => stats({ queued: 50, oldestQueuedAgeMs: 3 * 60 * 60_000 }), { warn() {}, info() {} });
        const release = await controller.acquire("voice");
        release();
    });
});

describe("Phase 1D persistent queue integration", () => {
    test("stats vraća depth/status/oldest age bez schema promene", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "wedding-queue-stats-"));
        const database = new Database(path.join(root, "queue.sqlite"));
        try {
            migrateProcessingJobs(database);
            let now = new Date("2026-08-23T12:00:00.000Z");
            const queue = new ProcessingQueue({ db: database, processors: {}, now: () => now });
            queue.enqueue("photo", 1, "video_process");
            now = new Date(now.getTime() + 31 * 60_000);
            queue.enqueue("voice_message", 2, "voice_normalize");
            const videoStats = queue.stats("video_process");
            assert.equal(videoStats.queued, 1);
            assert.equal(videoStats.processing, 0);
            assert.equal(videoStats.failed, 0);
            assert.equal(videoStats.oldestQueuedAgeMs, 31 * 60_000);
            assert.deepEqual(database.prepare("PRAGMA table_info(processing_jobs)").all().map((column) => column.name), [
                "id", "target_type", "target_id", "job_type", "status", "attempt_count", "max_attempts",
                "available_at", "started_at", "completed_at", "last_error", "created_at"
            ]);
        } finally {
            database.close();
            await rm(root, { recursive: true, force: true });
        }
    });

    test("emergency beforeClaim ne claim-uje job; worker concurrency ostaje jedan", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "wedding-queue-pause-"));
        const database = new Database(path.join(root, "queue.sqlite"));
        try {
            migrateProcessingJobs(database);
            let processed = 0;
            const queue = new ProcessingQueue({
                db: database,
                processors: { video_process: async () => { processed += 1; } },
                beforeClaim: async () => false,
                idlePollMs: 1_000
            });
            queue.enqueue("photo", 1, "video_process");
            queue.start();
            await new Promise((resolve) => setTimeout(resolve, 30));
            await queue.stop();
            assert.equal(processed, 0);
            const queueStats = queue.stats("video_process");
            assert.equal(queueStats.queued, 1);
            assert.equal(queueStats.processing, 0);
            assert.equal(queueStats.failed, 0);
            assert.ok(queueStats.oldestQueuedAgeMs !== null && queueStats.oldestQueuedAgeMs >= 0);
        } finally {
            database.close();
            await rm(root, { recursive: true, force: true });
        }
    });
});

async function startServer(capacityAvailableBytes) {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wedding-capacity-test-"));
    const child = spawn(process.execPath, ["dist/server.js"], {
        cwd: backendRoot,
        env: {
            ...process.env, NODE_ENV: "test", PORT: "0", TEST_DATA_ROOT: dataRoot,
            TEST_DISABLE_PROCESSING_WORKER: "1", TEST_SKIP_AI_MODERATION: "1",
            TEST_CAPACITY_TOTAL_BYTES: String(500 * GiB), TEST_CAPACITY_AVAILABLE_BYTES: String(capacityAvailableBytes),
            SESSION_SECRET: "test-session-secret-at-least-32-characters-long", ADMIN_EMAIL: "admin@example.test",
            ADMIN_PANEL_URL: "http://localhost/admin.html", DEFAULT_ADMIN_USERNAME: "test-admin",
            DEFAULT_ADMIN_PASSWORD: "test-password-at-least-12-characters",
            EVENT_UNLOCK_AT: "2020-10-10T08:00:00+02:00", WEDDING_AT: "2020-10-10T13:30:00+02:00"
        }, stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`server timeout ${output}`)), 15_000);
        child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { output += chunk; const match = output.match(/Server radi na portu (\d+)/); if (match) { clearTimeout(timeout); resolve(Number(match[1])); } });
        child.stderr.on("data", (chunk) => { output += chunk; });
        child.once("exit", (code) => reject(new Error(`server exit ${code} ${output}`)));
    });
    const server = { dataRoot, baseUrl: `http://127.0.0.1:${port}`, getOutput() { return output; }, async stop() { if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); } await rm(dataRoot, { recursive: true, force: true }); } };
    return server;
}

describe("Phase 1D endpoint admission", () => {
    test("low disk vraća 503 pre Multer/DB/queue i read rute ostaju dostupne", async () => {
        const server = await startServer(20 * GiB);
        try {
            const form = new FormData();
            form.append("photo", new Blob([await sharp({ create: { width: 800, height: 800, channels: 3, background: "white" } }).jpeg().toBuffer()], { type: "image/jpeg" }), "photo.jpg");
            const response = await fetch(`${server.baseUrl}/api/upload/image`, { method: "POST", body: form });
            assert.equal(response.status, 503);
            assert.equal(response.headers.get("retry-after"), String(CAPACITY_POLICY.retryAfterSeconds));
            assert.equal((await response.json()).code, "LOW_DISK_SPACE");
            assert.match(server.getOutput(), /\[CAPACITY_REJECTION\] category=image code=LOW_DISK_SPACE suppressed=0/);
            assert.doesNotMatch(server.getOutput(), /photo\.jpg|capacity-test-client/);
            const db = new Database(path.join(server.dataRoot, "database.sqlite"), { readonly: true });
            assert.equal(db.prepare("SELECT COUNT(*) AS count FROM photos").get().count, 0);
            assert.equal(db.prepare("SELECT COUNT(*) AS count FROM processing_jobs").get().count, 0);
            db.close();
            assert.deepEqual(await readdir(path.join(server.dataRoot, "uploads", "original")), []);
            for (const endpoint of ["/api/health", "/api/event-config", "/api/photos?page=1&limit=1"]) {
                assert.equal((await fetch(`${server.baseUrl}${endpoint}`)).status, 200);
            }
            const likeResponse = await fetch(`${server.baseUrl}/api/photos/999999/like`, {
                method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "capacity-test-client" })
            });
            assert.notEqual(likeResponse.status, 503);
            const loginResponse = await fetch(`${server.baseUrl}/api/admin/login`, {
                method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "invalid", password: "invalid" })
            });
            assert.notEqual(loginResponse.status, 503);
        } finally {
            await server.stop();
        }
    });
});

describe("Phase 1D frontend static coverage", () => {
    test("jedan mixed picker, progress i SR/EN/DE capacity poruke ostaju prisutni", async () => {
        const { readFile } = await import("node:fs/promises");
        const upload = await readFile(path.join(backendRoot, "..", "frontend", "js", "upload.js"), "utf8");
        const voice = await readFile(path.join(backendRoot, "..", "frontend", "js", "voice-messages.js"), "utf8");
        const translations = await readFile(path.join(backendRoot, "..", "frontend", "js", "translations.js"), "utf8");
        assert.match(upload, /input\.accept = "image\/\*,video\/\*/);
        assert.match(upload, /input\.multiple = true/);
        assert.match(upload, /xhr\.upload\.onprogress/);
        assert.match(upload, /upload_capacity_busy/);
        assert.match(voice, /voice_capacity_busy/);
        assert.equal((translations.match(/upload_capacity_busy:/g) || []).length, 3);
        assert.equal((translations.match(/voice_capacity_busy:/g) || []).length, 3);
    });
});
