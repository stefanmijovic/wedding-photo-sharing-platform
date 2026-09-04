import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
    FFMPEG_HARD_CAP_MS,
    FFMPEG_MIN_DEADLINE_MS,
    FfmpegWatchdogError,
    calculateFfmpegDeadlineMs,
    cleanupFfmpegPartials,
    watchFfmpegChild
} from "../dist/ffmpeg-watchdog.js";
import { ProcessingQueue, migrateProcessingJobs } from "../dist/processing-queue.js";

class StubChild extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    signals = [];
    onKill;
    constructor(onKill) {
        super();
        this.onKill = onKill;
    }
    kill(signal) {
        this.signals.push(signal);
        this.onKill?.(signal, this);
        return true;
    }
}

test("progress resetuje inactivity watchdog i normalan exit ne šalje signal", async () => {
    const child = new StubChild();
    const watched = watchFfmpegChild(child, { jobId: 1, mediaId: 2 }, {
        inactivityMs: 20,
        termGraceMs: 10,
        absoluteDeadlineMs: 200
    });
    const progress = setInterval(() => child.stdout.write("frame=1\nprogress=continue\n"), 5);
    setTimeout(() => { clearInterval(progress); child.emit("close", 0, null); }, 45);
    await watched;
    assert.deepEqual(child.signals, []);
});

test("inactivity šalje SIGTERM, exit u grace periodu ne šalje SIGKILL", async () => {
    const child = new StubChild((signal, instance) => {
        if (signal === "SIGTERM") setTimeout(() => instance.emit("close", null, "SIGTERM"), 2);
    });
    await assert.rejects(
        watchFfmpegChild(child, { jobId: 3, mediaId: 4 }, { inactivityMs: 10, termGraceMs: 20, absoluteDeadlineMs: 200 }),
        (error) => error instanceof FfmpegWatchdogError && error.reason === "inactivity" && error.retryable
    );
    assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("child koji ignoriše SIGTERM dobija SIGKILL", async () => {
    const child = new StubChild((signal, instance) => {
        if (signal === "SIGKILL") setTimeout(() => instance.emit("close", null, "SIGKILL"), 1);
    });
    await assert.rejects(
        watchFfmpegChild(child, { jobId: 5, mediaId: 6 }, { inactivityMs: 10, termGraceMs: 10, absoluteDeadlineMs: 200 }),
        (error) => error instanceof FfmpegWatchdogError && error.code === "FFMPEG_WATCHDOG_TIMEOUT"
    );
    assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("absolute deadline šalje TERM čak i uz progress", async () => {
    const child = new StubChild((signal, instance) => {
        if (signal === "SIGTERM") setTimeout(() => instance.emit("close", null, "SIGTERM"), 1);
    });
    const progress = setInterval(() => child.stdout.write("out_time_ms=1000\n"), 4);
    await assert.rejects(
        watchFfmpegChild(child, { jobId: 7, mediaId: 8 }, { inactivityMs: 50, termGraceMs: 10, absoluteDeadlineMs: 20 }),
        (error) => error instanceof FfmpegWatchdogError && error.reason === "deadline"
    );
    clearInterval(progress);
});

test("deadline policy ima minimum, workload scaling, hard cap i invalid fallback", () => {
    assert.equal(calculateFfmpegDeadlineMs({ durationSeconds: 10, width: 1920, height: 1080, fps: 30 }), FFMPEG_MIN_DEADLINE_MS);
    const long1080 = calculateFfmpegDeadlineMs({ durationSeconds: 3600, width: 1920, height: 1080, fps: 30 });
    const fourK60 = calculateFfmpegDeadlineMs({ durationSeconds: 3600, width: 3840, height: 2160, fps: 60 });
    assert.ok(long1080 > FFMPEG_MIN_DEADLINE_MS);
    assert.ok(fourK60 >= long1080);
    assert.equal(fourK60, FFMPEG_HARD_CAP_MS);
    assert.equal(calculateFfmpegDeadlineMs({ durationSeconds: NaN }), FFMPEG_MIN_DEADLINE_MS);
});

test("timeout cleanup uklanja samo partiale i zadržava original/final", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ffmpeg-cleanup-"));
    try {
        const original = path.join(root, "original.mp4");
        const final = path.join(root, "final.mp4");
        const partialA = path.join(root, "thumb.processing-1.jpg");
        const partialB = path.join(root, "web.processing-1.mp4");
        await Promise.all([original, final, partialA, partialB].map((file) => writeFile(file, file)));
        cleanupFfmpegPartials([partialA, partialB]);
        assert.match(await readFile(original, "utf8"), /original/);
        assert.match(await readFile(final, "utf8"), /final/);
        await assert.rejects(readFile(partialA));
        await assert.rejects(readFile(partialB));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("retryable watchdog failure ne blokira sledeći queue job", async () => {
    const db = new Database(":memory:");
    migrateProcessingJobs(db);
    const processed = [];
    const queue = new ProcessingQueue({
        db,
        retryDelaysMs: [1],
        processors: {
            video_process: async (job) => {
                processed.push(job.targetId);
                if (job.targetId === 1) throw new FfmpegWatchdogError("inactivity");
            }
        }
    });
    queue.enqueue("photo", 1, "video_process", 2);
    queue.enqueue("photo", 2, "video_process", 2);
    assert.equal(await queue.processNext(), true);
    assert.equal(await queue.processNext(), true);
    assert.deepEqual(processed, [1, 2]);
    assert.equal(queue.getByTarget("photo", 1, "video_process").status, "queued");
    assert.equal(queue.getByTarget("photo", 2, "video_process").status, "completed");
    db.close();
});
