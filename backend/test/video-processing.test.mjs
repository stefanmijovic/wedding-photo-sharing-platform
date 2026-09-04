import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import sharp from "sharp";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function startTestServer(extraEnv = {}) {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wedding-video-test-"));
    const child = spawn(process.execPath, ["dist/server.js"], {
        cwd: backendRoot,
        env: {
            ...process.env,
            NODE_ENV: "test",
            PORT: "0",
            TEST_DATA_ROOT: dataRoot,
            SESSION_SECRET: "test-session-secret-at-least-32-characters-long",
            ADMIN_EMAIL: "admin@example.test",
            ADMIN_PANEL_URL: "http://localhost/admin.html",
            DEFAULT_ADMIN_USERNAME: "test-admin",
            DEFAULT_ADMIN_PASSWORD: "test-password-at-least-12-characters",
            EVENT_UNLOCK_AT: "2020-10-10T08:00:00+02:00",
            WEDDING_AT: "2020-10-10T13:30:00+02:00",
            TEST_SKIP_AI_MODERATION: "1",
            TEST_VIDEO_PROBE: "stub",
            ...extraEnv
        },
        stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    let errorOutput = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { errorOutput += chunk; });
    const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Server timeout\n${output}\n${errorOutput}`)), 15_000);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            output += chunk;
            const match = output.match(/Server radi na portu (\d+)/);
            if (match) {
                clearTimeout(timeout);
                resolve(Number(match[1]));
            }
        });
        child.once("exit", (code) => {
            clearTimeout(timeout);
            reject(new Error(`Server exit ${code}\n${output}\n${errorOutput}`));
        });
    });

    return {
        baseUrl: `http://127.0.0.1:${port}`,
        dataRoot,
        databasePath: path.join(dataRoot, "database.sqlite"),
        async stop() {
            if (child.exitCode === null) {
                child.kill("SIGTERM");
                await new Promise((resolve) => child.once("exit", resolve));
            }
            await rm(dataRoot, { recursive: true, force: true });
        }
    };
}

async function uploadFile(server, filename, type, bytes, endpoint = "/api/upload/video") {
    const form = new FormData();
    form.append("photo", new Blob([bytes], { type }), filename);
    return fetch(`${server.baseUrl}${endpoint}`, { method: "POST", body: form });
}

async function login(server) {
    const response = await fetch(`${server.baseUrl}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        body: JSON.stringify({ username: "test-admin", password: "test-password-at-least-12-characters" })
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";", 1)[0];
}

async function waitFor(check, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Uslov nije ispunjen na vreme.");
}

describe("video upload sa zaustavljenim workerom", () => {
    let server;
    before(async () => {
        server = await startTestServer({ TEST_DISABLE_PROCESSING_WORKER: "1" });
    });
    after(async () => { await server?.stop(); });

    test("video upload atomarno kreira media i jedinstveni queued job", async () => {
        const response = await uploadFile(server, "guest.mp4", "video/mp4", Buffer.from("test-video"));
        assert.equal(response.status, 200);
        const db = new Database(server.databasePath, { readonly: true });
        const photo = db.prepare("SELECT * FROM photos WHERE media_type = 'video'").get();
        const jobs = db.prepare("SELECT * FROM processing_jobs WHERE target_id = ?").all(photo.id);
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].status, "queued");
        assert.equal(jobs[0].job_type, "video_process");
        db.close();
    });

    test("video ne može da se odobri dok processing nije completed", async () => {
        const db = new Database(server.databasePath, { readonly: true });
        const id = db.prepare("SELECT id FROM photos WHERE media_type = 'video'").get().id;
        db.close();
        const cookie = await login(server);
        const response = await fetch(`${server.baseUrl}/api/admin/photos/${id}/approve`, {
            method: "PATCH",
            headers: { Cookie: cookie, Origin: "http://localhost" }
        });
        assert.equal(response.status, 409);
    });

    test("manual retry resetuje failed job bez duplikata", async () => {
        const db = new Database(server.databasePath);
        const id = db.prepare("SELECT id FROM photos WHERE media_type = 'video'").get().id;
        db.prepare("UPDATE processing_jobs SET status = 'failed', attempt_count = 4 WHERE target_id = ?").run(id);
        db.close();
        const cookie = await login(server);
        const response = await fetch(`${server.baseUrl}/api/admin/photos/${id}/retry-processing`, {
            method: "POST",
            headers: { Cookie: cookie, Origin: "http://localhost" }
        });
        assert.equal(response.status, 200);
        const checkDb = new Database(server.databasePath, { readonly: true });
        const jobs = checkDb.prepare("SELECT * FROM processing_jobs WHERE target_id = ?").all(id);
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].status, "queued");
        assert.equal(jobs[0].attempt_count, 0);
        checkDb.close();
    });

    test("delete uklanja queued job i sprečava buduću obradu", async () => {
        const db = new Database(server.databasePath, { readonly: true });
        const photo = db.prepare("SELECT id, filename FROM photos WHERE media_type = 'video'").get();
        db.close();
        const cookie = await login(server);
        const response = await fetch(`${server.baseUrl}/api/admin/photos/${photo.id}`, {
            method: "DELETE",
            headers: { Cookie: cookie, Origin: "http://localhost" }
        });
        assert.equal(response.status, 200);
        const checkDb = new Database(server.databasePath, { readonly: true });
        assert.equal(checkDb.prepare("SELECT COUNT(*) count FROM photos WHERE id = ?").get(photo.id).count, 0);
        assert.equal(checkDb.prepare("SELECT COUNT(*) count FROM processing_jobs WHERE target_id = ?").get(photo.id).count, 0);
        checkDb.close();
        assert.equal(existsSync(path.join(server.dataRoot, "uploads", "videos", "original", photo.filename)), false);
    });

    test("image upload tok ostaje sinhron i ne kreira processing job", async () => {
        const png = await sharp({
            create: { width: 900, height: 900, channels: 3, background: "white" }
        }).png().toBuffer();
        const response = await uploadFile(server, "photo.png", "image/png", png, "/api/upload/image");
        assert.equal(response.status, 200);
        assert.equal((await response.json()).mediaType, "image");
        const db = new Database(server.databasePath, { readonly: true });
        assert.equal(db.prepare("SELECT COUNT(*) count FROM photos WHERE media_type = 'image'").get().count, 1);
        assert.equal(db.prepare("SELECT COUNT(*) count FROM processing_jobs").get().count, 0);
        db.close();
    });
});

describe("video worker integration sa kontrolisanim processor adapterom", () => {
    let server;
    before(async () => {
        server = await startTestServer({ TEST_VIDEO_PROCESSOR: "stub" });
    });
    after(async () => { await server?.stop(); });

    test("completed video dobija thumbnail, web output i completed job", async () => {
        const response = await uploadFile(server, "processed.mp4", "video/mp4", Buffer.from("test-video"));
        assert.equal(response.status, 200);
        const result = await waitFor(() => {
            const db = new Database(server.databasePath, { readonly: true });
            const row = db.prepare(`
                SELECT photos.*, processing_jobs.status AS processing_status
                FROM photos JOIN processing_jobs ON processing_jobs.target_id = photos.id
                WHERE photos.media_type = 'video'
            `).get();
            db.close();
            return row?.processing_status === "completed" ? row : null;
        });
        assert.ok(result.thumb_url);
        assert.ok(result.web_url);
        assert.equal(existsSync(path.join(server.dataRoot, result.thumb_url)), true);
        assert.equal(existsSync(path.join(server.dataRoot, result.web_url)), true);
    });
});

describe("delete tokom aktivne video obrade", () => {
    let server;
    before(async () => {
        server = await startTestServer({
            TEST_VIDEO_PROCESSOR: "stub",
            TEST_VIDEO_PROCESSOR_DELAY_MS: "300"
        });
    });
    after(async () => { await server?.stop(); });

    test("aktivni job ne može da vrati obrisani video ili output fajlove", async () => {
        const response = await uploadFile(server, "active.mp4", "video/mp4", Buffer.from("test-video"));
        assert.equal(response.status, 200);
        const processing = await waitFor(() => {
            const db = new Database(server.databasePath, { readonly: true });
            const row = db.prepare(`
                SELECT photos.id, photos.filename, processing_jobs.status
                FROM photos JOIN processing_jobs ON processing_jobs.target_id = photos.id
                WHERE photos.media_type = 'video'
            `).get();
            db.close();
            return row?.status === "processing" ? row : null;
        });
        const cookie = await login(server);
        const deleteResponse = await fetch(`${server.baseUrl}/api/admin/photos/${processing.id}`, {
            method: "DELETE",
            headers: { Cookie: cookie, Origin: "http://localhost" }
        });
        assert.equal(deleteResponse.status, 200);
        await new Promise((resolve) => setTimeout(resolve, 500));

        const db = new Database(server.databasePath, { readonly: true });
        assert.equal(db.prepare("SELECT COUNT(*) count FROM photos WHERE id = ?").get(processing.id).count, 0);
        assert.equal(db.prepare("SELECT COUNT(*) count FROM processing_jobs WHERE target_id = ?").get(processing.id).count, 0);
        db.close();
        assert.equal(existsSync(path.join(server.dataRoot, "uploads", "videos", "thumbs", `${processing.filename}.jpg`)), false);
        assert.equal(existsSync(path.join(server.dataRoot, "uploads", "videos", "web", `${path.parse(processing.filename).name}.mp4`)), false);
    });
});
