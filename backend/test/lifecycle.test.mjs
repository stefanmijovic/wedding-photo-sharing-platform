import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import Database from "better-sqlite3";
import sharp from "sharp";
import {
    LifecycleController,
    readinessDecision,
    settleWithin
} from "../dist/lifecycle.js";
import { ProcessingQueue, migrateProcessingJobs } from "../dist/processing-queue.js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GiB = 1024 ** 3;

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer(extraEnv = {}) {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wedding-lifecycle-"));
    const child = spawn(process.execPath, ["dist/server.js"], {
        cwd: backendRoot,
        env: {
            ...process.env,
            NODE_ENV: "test",
            PORT: "0",
            TEST_DATA_ROOT: dataRoot,
            TEST_DISABLE_PROCESSING_WORKER: "1",
            TEST_SKIP_AI_MODERATION: "1",
            TEST_CAPACITY_TOTAL_BYTES: String(500 * GiB),
            TEST_CAPACITY_AVAILABLE_BYTES: String(200 * GiB),
            SESSION_SECRET: "test-session-secret-at-least-32-characters-long",
            ADMIN_EMAIL: "admin@example.test",
            ADMIN_PANEL_URL: "http://localhost/admin.html",
            DEFAULT_ADMIN_USERNAME: "test-admin",
            DEFAULT_ADMIN_PASSWORD: "test-password-at-least-12-characters",
            EVENT_UNLOCK_AT: "2020-10-10T08:00:00+02:00",
            WEDDING_AT: "2020-10-10T13:30:00+02:00",
            ...extraEnv
        },
        stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`server timeout: ${output}`)), 15_000);
        const inspect = () => {
            const match = output.match(/Server radi na portu (\d+)/);
            if (match) {
                clearTimeout(timeout);
                resolve(Number(match[1]));
            }
        };
        child.stdout.on("data", inspect);
        child.once("exit", (code) => {
            clearTimeout(timeout);
            reject(new Error(`server exited ${code}: ${output}`));
        });
    });
    return {
        child,
        dataRoot,
        baseUrl: `http://127.0.0.1:${port}`,
        output: () => output,
        async cleanup() {
            if (child.exitCode === null) {
                child.kill("SIGTERM");
                await new Promise((resolve) => child.once("exit", resolve));
            }
            await rm(dataRoot, { recursive: true, force: true });
        }
    };
}

function waitForExit(child, timeoutMs = 3_000) {
    if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    return Promise.race([
        new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
        wait(timeoutMs).then(() => { throw new Error("child did not exit within bounded timeout"); })
    ]);
}

describe("Phase 1F lifecycle/readiness policy", () => {
    test("controller state, request counter and shutdown are idempotent", () => {
        let now = 123;
        const lifecycle = new LifecycleController(() => now);
        const release = lifecycle.beginRequest();
        assert.equal(lifecycle.activeRequests, 1);
        release(); release();
        assert.equal(lifecycle.activeRequests, 0);
        assert.equal(lifecycle.beginShutdown(), true);
        assert.equal(lifecycle.shutdownStartedAt, 123);
        now = 456;
        assert.equal(lifecycle.beginShutdown(), false);
        assert.equal(lifecycle.shutdownStartedAt, 123);
    });

    test("warning/reject ostaju ready; emergency/unknown/shutdown nisu ready", () => {
        const lifecycle = new LifecycleController();
        for (const state of ["healthy", "warning", "reject"]) {
            assert.equal(readinessDecision(lifecycle, [state]).ready, true);
        }
        assert.deepEqual(readinessDecision(lifecycle, ["emergency"]), { ready: false, reason: "capacity" });
        assert.deepEqual(readinessDecision(lifecycle, ["unknown"]), { ready: false, reason: "capacity" });
        lifecycle.beginShutdown();
        assert.deepEqual(readinessDecision(lifecycle, ["healthy"]), { ready: false, reason: "shutdown" });
    });

    test("settleWithin završava rano ili vraća bounded timeout", async () => {
        assert.deepEqual(await settleWithin(Promise.resolve("ok"), 100), { completed: true, value: "ok" });
        assert.deepEqual(await settleWithin(new Promise(() => {}), 5), { completed: false });
    });
});

describe("Phase 1F HTTP readiness and signal drain", {
    skip: process.platform === "win32" ? "POSIX signal-drain semantics require Linux/macOS." : false
}, () => {
    for (const [label, available, readyStatus] of [
        ["healthy", 200 * GiB, 200],
        ["warning", 95 * GiB, 200],
        ["upload reject", 55 * GiB, 200],
        ["emergency", 11 * GiB, 503]
    ]) {
        test(`${label}: health 200 i readiness ${readyStatus}`, async () => {
            const server = await startServer({ TEST_CAPACITY_AVAILABLE_BYTES: String(available) });
            try {
                assert.equal((await fetch(`${server.baseUrl}/api/health`)).status, 200);
                const ready = await fetch(`${server.baseUrl}/api/ready`);
                assert.equal(ready.status, readyStatus);
                if (readyStatus === 503) assert.equal((await ready.json()).code, "SERVICE_NOT_READY");
            } finally {
                await server.cleanup();
            }
        });
    }

    test("SIGTERM drains an existing request, closes listener and exits gracefully", async () => {
        const server = await startServer({ TEST_SLOW_REQUEST_MS: "80", TEST_SHUTDOWN_TIMEOUT_MS: "1000" });
        try {
            const existing = fetch(`${server.baseUrl}/api/test/slow`);
            await wait(15);
            server.child.kill("SIGTERM");
            const response = await existing;
            assert.equal(response.status, 200);
            await response.text();
            const exit = await waitForExit(server.child);
            assert.equal(exit.code, 0, server.output());
            assert.match(server.output(), /Graceful shutdown završen/);
        } finally {
            await server.cleanup();
        }
    });

    test("SIGINT koristi isti idempotent flow; drugi signal ne duplira cleanup", async () => {
        const server = await startServer({ TEST_SLOW_REQUEST_MS: "80", TEST_SHUTDOWN_TIMEOUT_MS: "1000" });
        try {
            const existing = fetch(`${server.baseUrl}/api/test/slow`);
            await wait(15);
            server.child.kill("SIGINT");
            server.child.kill("SIGTERM");
            const response = await existing;
            assert.equal(response.status, 200);
            await response.text();
            const exit = await waitForExit(server.child);
            assert.equal(exit.code, 0, server.output());
            assert.equal((server.output().match(/bounded graceful shutdown počinje/g) || []).length, 1);
            assert.match(server.output(), /shutdown već u toku/);
        } finally {
            await server.cleanup();
        }
    });

    test("upload započet pre shutdown-a završava; novi upload se odbija ili listener više nije dostupan", async () => {
        const server = await startServer({ TEST_AI_MODERATION_DELAY_MS: "100", TEST_SHUTDOWN_TIMEOUT_MS: "1000" });
        const jpeg = await sharp({ create: { width: 800, height: 800, channels: 3, background: "white" } }).jpeg().toBuffer();
        try {
            const activeForm = new FormData();
            activeForm.append("photo", new Blob([jpeg], { type: "image/jpeg" }), "active.jpg");
            const activeUpload = fetch(`${server.baseUrl}/api/upload/image`, { method: "POST", body: activeForm });
            await wait(25);
            server.child.kill("SIGTERM");

            const newForm = new FormData();
            newForm.append("photo", new Blob([jpeg], { type: "image/jpeg" }), "new.jpg");
            const newUpload = await fetch(`${server.baseUrl}/api/upload/image`, { method: "POST", body: newForm })
                .then(async (response) => ({ status: response.status, body: await response.text() }))
                .catch(() => null);
            if (newUpload) {
                assert.equal(newUpload.status, 503);
                assert.match(newUpload.body, /SERVICE_SHUTTING_DOWN/);
            }

            const activeResponse = await activeUpload;
            const activeBody = await activeResponse.text();
            assert.equal(activeResponse.status, 200, activeBody);
            assert.equal((await waitForExit(server.child)).code, 0, server.output());
            assert.equal((await readdir(path.join(server.dataRoot, "uploads", "original"))).length, 1);
            assert.equal((await readdir(path.join(server.dataRoot, "uploads", "thumbs"))).length, 1);
        } finally {
            await server.cleanup();
        }
    });

    test("forced deadline closes a stuck request and exits bounded", async () => {
        const server = await startServer({ TEST_SLOW_REQUEST_MS: "500", TEST_SHUTDOWN_TIMEOUT_MS: "20" });
        try {
            const existing = fetch(`${server.baseUrl}/api/test/slow`).catch(() => null);
            await wait(10);
            const started = Date.now();
            server.child.kill("SIGTERM");
            const exit = await waitForExit(server.child);
            assert.equal(exit.code, 1, server.output());
            assert.ok(Date.now() - started < 1_000);
            assert.match(server.output(), /Shutdown deadline istekao/);
            await existing;
        } finally {
            await server.cleanup();
        }
    });
});

describe("Phase 1F processing drain and stale recovery", {
    skip: process.platform === "win32" ? "POSIX signal-drain semantics require Linux/macOS." : false
}, () => {
    test("stop čeka aktivni posao i ne claim-uje sledeći", async () => {
        const db = new Database(":memory:");
        migrateProcessingJobs(db);
        let releaseActive;
        const activeGate = new Promise((resolve) => { releaseActive = resolve; });
        let startedResolve;
        const started = new Promise((resolve) => { startedResolve = resolve; });
        const processed = [];
        const queue = new ProcessingQueue({
            db,
            idlePollMs: 5,
            processors: { video_process: async (job) => { processed.push(job.targetId); startedResolve(); await activeGate; } }
        });
        queue.enqueue("photo", 1, "video_process");
        queue.enqueue("photo", 2, "video_process");
        queue.start();
        await started;
        const stopping = queue.stop();
        releaseActive();
        await stopping;
        assert.deepEqual(processed, [1]);
        assert.equal(queue.getByTarget("photo", 1, "video_process").status, "completed");
        assert.equal(queue.getByTarget("photo", 2, "video_process").status, "queued");
        db.close();
    });

    test("forced interruption ostaje processing i postojeći stale recovery ga vraća", async () => {
        const db = new Database(":memory:");
        migrateProcessingJobs(db);
        let now = new Date("2026-08-23T10:00:00.000Z");
        const queue = new ProcessingQueue({ db, now: () => now, staleAfterMs: 100, processors: { video_process: async () => {} } });
        queue.enqueue("photo", 9, "video_process");
        const claimed = queue.claimNext();
        assert.equal(claimed.status, "processing");
        now = new Date(now.getTime() + 101);
        assert.deepEqual(queue.recoverStale(), { requeued: 1, failed: 0 });
        assert.equal(queue.getByTarget("photo", 9, "video_process").status, "queued");
        db.close();
    });
});
