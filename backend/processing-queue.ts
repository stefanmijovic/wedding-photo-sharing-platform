import type Database from "better-sqlite3";

export type ProcessingJobStatus = "queued" | "processing" | "completed" | "failed";

export interface ProcessingJob {
    id: number;
    targetType: string;
    targetId: number;
    jobType: string;
    status: ProcessingJobStatus;
    attemptCount: number;
    maxAttempts: number;
    availableAt: string;
    startedAt: string | null;
    completedAt: string | null;
    lastError: string | null;
    createdAt: string;
}

type JobProcessor = (job: ProcessingJob) => Promise<void>;

interface ProcessingQueueOptions {
    db: Database.Database;
    processors: Record<string, JobProcessor>;
    retryDelaysMs?: number[];
    staleAfterMs?: number;
    idlePollMs?: number;
    now?: () => Date;
}

const DEFAULT_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const DEFAULT_STALE_AFTER_MS = 30 * 60_000;
const DEFAULT_IDLE_POLL_MS = 30_000;

export function migrateProcessingJobs(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS processing_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target_type TEXT NOT NULL,
            target_id INTEGER NOT NULL,
            job_type TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
            attempt_count INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT 4,
            available_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(target_type, target_id, job_type)
        );

        CREATE INDEX IF NOT EXISTS idx_processing_jobs_ready
        ON processing_jobs(status, available_at, id);

        CREATE INDEX IF NOT EXISTS idx_processing_jobs_target
        ON processing_jobs(target_type, target_id);
    `);
}

function toProcessingJob(row: any): ProcessingJob {
    return {
        id: Number(row.id),
        targetType: String(row.target_type),
        targetId: Number(row.target_id),
        jobType: String(row.job_type),
        status: row.status as ProcessingJobStatus,
        attemptCount: Number(row.attempt_count),
        maxAttempts: Number(row.max_attempts),
        availableAt: String(row.available_at),
        startedAt: row.started_at === null ? null : String(row.started_at),
        completedAt: row.completed_at === null ? null : String(row.completed_at),
        lastError: row.last_error === null ? null : String(row.last_error),
        createdAt: String(row.created_at)
    };
}

function safeErrorMessage(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw
        .replace(/[A-Za-z]:\\[^\r\n]*/g, "[path]")
        .replace(/\/(?:[^\s/]+\/)+[^\s]*/g, "[path]")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1000) || "Nepoznata processing greška";
}

export class ProcessingQueue {
    private readonly db: Database.Database;
    private readonly processors: Record<string, JobProcessor>;
    private readonly retryDelaysMs: number[];
    private readonly staleAfterMs: number;
    private readonly idlePollMs: number;
    private readonly now: () => Date;
    private stopping = false;
    private started = false;
    private workerPromise: Promise<void> | null = null;
    private wakeTimer: NodeJS.Timeout | null = null;

    constructor(options: ProcessingQueueOptions) {
        this.db = options.db;
        this.processors = options.processors;
        this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
        this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
        this.idlePollMs = options.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
        this.now = options.now ?? (() => new Date());
    }

    enqueue(targetType: string, targetId: number, jobType: string, maxAttempts = 4): ProcessingJob {
        const now = this.now().toISOString();
        this.db.prepare(`
            INSERT INTO processing_jobs (
                target_type,
                target_id,
                job_type,
                status,
                attempt_count,
                max_attempts,
                available_at,
                created_at
            ) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)
            ON CONFLICT(target_type, target_id, job_type) DO NOTHING
        `).run(targetType, targetId, jobType, maxAttempts, now, now);

        const job = this.getByTarget(targetType, targetId, jobType);
        if (!job) {
            throw new Error("Processing job nije moguće kreirati.");
        }

        console.log(`Processing queue: queued job ${job.id} ${job.jobType} target=${job.targetId}`);
        queueMicrotask(() => this.wake());
        return job;
    }

    getByTarget(targetType: string, targetId: number, jobType: string): ProcessingJob | null {
        const row = this.db.prepare(`
            SELECT *
            FROM processing_jobs
            WHERE target_type = ? AND target_id = ? AND job_type = ?
        `).get(targetType, targetId, jobType);
        return row ? toProcessingJob(row) : null;
    }

    claimNext(): ProcessingJob | null {
        const claim = this.db.transaction(() => {
            const now = this.now().toISOString();
            const row = this.db.prepare(`
                SELECT *
                FROM processing_jobs
                WHERE status = 'queued' AND available_at <= ?
                ORDER BY available_at ASC, id ASC
                LIMIT 1
            `).get(now) as any;

            if (!row) {
                return null;
            }

            const result = this.db.prepare(`
                UPDATE processing_jobs
                SET
                    status = 'processing',
                    attempt_count = attempt_count + 1,
                    started_at = ?,
                    completed_at = NULL,
                    last_error = NULL
                WHERE id = ? AND status = 'queued' AND available_at <= ?
            `).run(now, row.id, now);

            if (result.changes !== 1) {
                return null;
            }

            return this.db.prepare("SELECT * FROM processing_jobs WHERE id = ?").get(row.id);
        }).immediate();

        return claim ? toProcessingJob(claim) : null;
    }

    async processNext(): Promise<boolean> {
        const job = this.claimNext();
        if (!job) {
            return false;
        }

        const processor = this.processors[job.jobType];
        console.log(
            `Processing queue: starting job ${job.id} ${job.jobType} attempt ${job.attemptCount}/${job.maxAttempts}`
        );

        if (!processor) {
            this.recordFailure(job, new Error(`Nepoznat job type: ${job.jobType}`));
            return true;
        }

        try {
            await processor(job);
            const completedAt = this.now().toISOString();
            const result = this.db.prepare(`
                UPDATE processing_jobs
                SET status = 'completed', completed_at = ?, last_error = NULL
                WHERE id = ? AND status = 'processing'
            `).run(completedAt, job.id);

            if (result.changes === 1) {
                console.log(`Processing queue: completed job ${job.id}`);
            } else {
                console.log(`Processing queue: job ${job.id} target je uklonjen tokom obrade`);
            }
        } catch (error) {
            this.recordFailure(job, error);
        }

        return true;
    }

    private recordFailure(job: ProcessingJob, error: unknown): void {
        const message = safeErrorMessage(error);
        if (job.attemptCount >= job.maxAttempts) {
            const completedAt = this.now().toISOString();
            this.db.prepare(`
                UPDATE processing_jobs
                SET status = 'failed', completed_at = ?, last_error = ?
                WHERE id = ? AND status = 'processing'
            `).run(completedAt, message, job.id);
            console.error(`Processing queue: failed job ${job.id} after ${job.attemptCount} attempts`);
            return;
        }

        const delayIndex = Math.min(job.attemptCount - 1, this.retryDelaysMs.length - 1);
        const delayMs = this.retryDelaysMs[Math.max(0, delayIndex)] ?? DEFAULT_RETRY_DELAYS_MS[0]!;
        const availableAt = new Date(this.now().getTime() + delayMs).toISOString();
        this.db.prepare(`
            UPDATE processing_jobs
            SET
                status = 'queued',
                available_at = ?,
                started_at = NULL,
                completed_at = NULL,
                last_error = ?
            WHERE id = ? AND status = 'processing'
        `).run(availableAt, message, job.id);
        console.warn(`Processing queue: retry job ${job.id} in ${Math.round(delayMs / 1000)}s`);
    }

    recoverStale(): { requeued: number; failed: number } {
        const now = this.now();
        const staleBefore = new Date(now.getTime() - this.staleAfterMs).toISOString();
        const nowIso = now.toISOString();
        const staleJobs = this.db.prepare(`
            SELECT *
            FROM processing_jobs
            WHERE status = 'processing' AND started_at <= ?
        `).all(staleBefore).map(toProcessingJob);

        let requeued = 0;
        let failed = 0;
        const recover = this.db.transaction(() => {
            for (const job of staleJobs) {
                if (job.attemptCount >= job.maxAttempts) {
                    const result = this.db.prepare(`
                        UPDATE processing_jobs
                        SET status = 'failed', completed_at = ?, last_error = ?
                        WHERE id = ? AND status = 'processing'
                    `).run(nowIso, "Processing prekinut restartom nakon poslednjeg pokušaja.", job.id);
                    failed += result.changes;
                } else {
                    const result = this.db.prepare(`
                        UPDATE processing_jobs
                        SET status = 'queued', available_at = ?, started_at = NULL,
                            last_error = ?
                        WHERE id = ? AND status = 'processing'
                    `).run(nowIso, "Processing prekinut restartom; posao je vraćen u red.", job.id);
                    requeued += result.changes;
                }

                console.log(`Processing queue: recovered stale job ${job.id}`);
            }
        });
        recover.immediate();
        return { requeued, failed };
    }

    retryFailed(targetType: string, targetId: number, jobType: string): boolean {
        const now = this.now().toISOString();
        const result = this.db.prepare(`
            UPDATE processing_jobs
            SET status = 'queued', attempt_count = 0, available_at = ?,
                started_at = NULL, completed_at = NULL, last_error = NULL
            WHERE target_type = ? AND target_id = ? AND job_type = ? AND status = 'failed'
        `).run(now, targetType, targetId, jobType);
        if (result.changes === 1) {
            this.wake();
            return true;
        }
        return false;
    }

    deleteForTarget(targetType: string, targetId: number): number {
        return this.db.prepare(`
            DELETE FROM processing_jobs WHERE target_type = ? AND target_id = ?
        `).run(targetType, targetId).changes;
    }

    start(): void {
        if (this.started) return;
        this.started = true;
        this.stopping = false;
        this.recoverStale();
        this.wake();
    }

    wake(): void {
        if (!this.started || this.stopping || this.workerPromise) return;
        if (this.wakeTimer) {
            clearTimeout(this.wakeTimer);
            this.wakeTimer = null;
        }
        this.workerPromise = this.runWorker().finally(() => {
            this.workerPromise = null;
            if (!this.stopping) this.scheduleWake();
        });
    }

    private async runWorker(): Promise<void> {
        while (!this.stopping && await this.processNext()) {
            // Global concurrency is intentionally one job at a time.
        }
    }

    private scheduleWake(): void {
        if (this.stopping || this.wakeTimer) return;
        const row = this.db.prepare(`
            SELECT available_at
            FROM processing_jobs
            WHERE status = 'queued'
            ORDER BY available_at ASC
            LIMIT 1
        `).get() as { available_at: string } | undefined;
        const delayedMs = row
            ? Math.max(0, Date.parse(row.available_at) - this.now().getTime())
            : this.idlePollMs;
        const waitMs = Math.min(Math.max(delayedMs, 25), this.idlePollMs);
        this.wakeTimer = setTimeout(() => {
            this.wakeTimer = null;
            this.recoverStale();
            this.wake();
        }, waitMs);
        this.wakeTimer.unref();
    }

    async stop(): Promise<void> {
        this.stopping = true;
        if (this.wakeTimer) {
            clearTimeout(this.wakeTimer);
            this.wakeTimer = null;
        }
        await this.workerPromise;
        this.started = false;
    }
}
