import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ProcessingQueue, migrateProcessingJobs } from "../dist/processing-queue.js";

describe("SQLite processing queue", () => {
    let dataRoot;
    let db;
    let now;

    beforeEach(async () => {
        dataRoot = await mkdtemp(path.join(os.tmpdir(), "wedding-queue-test-"));
        db = new Database(path.join(dataRoot, "queue.sqlite"));
        migrateProcessingJobs(db);
        now = new Date("2026-01-01T00:00:00.000Z");
    });

    afterEach(async () => {
        db.close();
        await rm(dataRoot, { recursive: true, force: true });
    });

    function queue(processor, options = {}) {
        return new ProcessingQueue({
            db,
            processors: { video_process: processor },
            retryDelaysMs: [1_000, 5_000, 15_000],
            staleAfterMs: 60_000,
            now: () => new Date(now),
            ...options
        });
    }

    test("enqueue kreira jedan posao i UNIQUE sprečava duplikat", () => {
        const processingQueue = queue(async () => {});
        const first = processingQueue.enqueue("photo", 27, "video_process");
        const second = processingQueue.enqueue("photo", 27, "video_process");
        assert.equal(first.id, second.id);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM processing_jobs").get().count, 1);
    });

    test("atomic claim preuzima samo jedan queued posao", () => {
        const processingQueue = queue(async () => {});
        processingQueue.enqueue("photo", 1, "video_process");
        const claimed = processingQueue.claimNext();
        assert.equal(claimed.status, "processing");
        assert.equal(claimed.attemptCount, 1);
        assert.equal(processingQueue.claimNext(), null);
    });

    test("uspešan processor završava posao kao completed", async () => {
        let calls = 0;
        const processingQueue = queue(async () => { calls++; });
        processingQueue.enqueue("photo", 1, "video_process");
        assert.equal(await processingQueue.processNext(), true);
        assert.equal(calls, 1);
        assert.equal(processingQueue.getByTarget("photo", 1, "video_process").status, "completed");
    });

    test("failure povećava attempt_count i zakazuje delayed retry", async () => {
        const processingQueue = queue(async () => { throw new Error("kontrolisana greška"); });
        processingQueue.enqueue("photo", 1, "video_process");
        await processingQueue.processNext();
        const job = processingQueue.getByTarget("photo", 1, "video_process");
        assert.equal(job.status, "queued");
        assert.equal(job.attemptCount, 1);
        assert.equal(job.availableAt, "2026-01-01T00:00:01.000Z");
        assert.match(job.lastError, /kontrolisana greška/);
    });

    test("max attempts završava posao kao failed bez beskonačnog retry-ja", async () => {
        const processingQueue = queue(async () => { throw new Error("uvek pada"); });
        processingQueue.enqueue("photo", 1, "video_process", 2);
        await processingQueue.processNext();
        now = new Date("2026-01-01T00:00:01.000Z");
        await processingQueue.processNext();
        const job = processingQueue.getByTarget("photo", 1, "video_process");
        assert.equal(job.status, "failed");
        assert.equal(job.attemptCount, 2);
        assert.equal(await processingQueue.processNext(), false);
    });

    test("stale processing posao se posle restarta vraća u queued", () => {
        const processingQueue = queue(async () => {});
        processingQueue.enqueue("photo", 1, "video_process");
        processingQueue.claimNext();
        now = new Date("2026-01-01T00:02:00.000Z");
        assert.deepEqual(processingQueue.recoverStale(), { requeued: 1, failed: 0 });
        assert.equal(processingQueue.getByTarget("photo", 1, "video_process").status, "queued");
    });

    test("stale posao sa iscrpljenim pokušajima postaje failed", () => {
        const processingQueue = queue(async () => {});
        processingQueue.enqueue("photo", 1, "video_process", 1);
        processingQueue.claimNext();
        now = new Date("2026-01-01T00:02:00.000Z");
        assert.deepEqual(processingQueue.recoverStale(), { requeued: 0, failed: 1 });
        assert.equal(processingQueue.getByTarget("photo", 1, "video_process").status, "failed");
    });

    test("completed posao se ne pokreće ponovo", async () => {
        let calls = 0;
        const processingQueue = queue(async () => { calls++; });
        processingQueue.enqueue("photo", 1, "video_process");
        await processingQueue.processNext();
        assert.equal(await processingQueue.processNext(), false);
        assert.equal(calls, 1);
    });

    test("manual retry resetuje samo failed posao bez duplikata", async () => {
        const processingQueue = queue(async () => { throw new Error("pad"); });
        processingQueue.enqueue("photo", 1, "video_process", 1);
        await processingQueue.processNext();
        assert.equal(processingQueue.retryFailed("photo", 1, "video_process"), true);
        const job = processingQueue.getByTarget("photo", 1, "video_process");
        assert.equal(job.status, "queued");
        assert.equal(job.attemptCount, 0);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM processing_jobs").get().count, 1);
    });
});
