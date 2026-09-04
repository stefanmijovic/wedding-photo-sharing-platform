import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import fs from "fs";
import { registerChildProcess } from "./child-process-registry.js";

export const FFMPEG_INACTIVITY_TIMEOUT_MS = 10 * 60_000;
export const FFMPEG_TERM_GRACE_MS = 20_000;
export const FFMPEG_MIN_DEADLINE_MS = 45 * 60_000;
export const FFMPEG_HARD_CAP_MS = 6 * 60 * 60_000;

export interface DeadlineMetadata {
    durationSeconds: number;
    width: number;
    height: number;
    fps: number;
}

export function calculateFfmpegDeadlineMs(metadata: Partial<DeadlineMetadata> | null | undefined): number {
    if (!metadata || !Number.isFinite(metadata.durationSeconds) || (metadata.durationSeconds ?? 0) <= 0) {
        return FFMPEG_MIN_DEADLINE_MS;
    }
    const pixels = Number.isFinite(metadata.width) && Number.isFinite(metadata.height)
        ? Math.max(1, Number(metadata.width) * Number(metadata.height))
        : 1920 * 1080;
    const fps = Number.isFinite(metadata.fps) && Number(metadata.fps) > 0 ? Number(metadata.fps) : 30;
    const workload = Math.min(8, Math.max(1, (pixels * fps) / (1920 * 1080 * 30)));
    const scaled = Number(metadata.durationSeconds) * 20 * workload * 1000;
    return Math.min(FFMPEG_HARD_CAP_MS, Math.max(FFMPEG_MIN_DEADLINE_MS, scaled));
}

export class FfmpegWatchdogError extends Error {
    readonly code = "FFMPEG_WATCHDOG_TIMEOUT";
    readonly retryable = true;
    constructor(public readonly reason: "inactivity" | "deadline") {
        super(`FFmpeg watchdog timeout: ${reason}`);
    }
}

export function cleanupFfmpegPartials(paths: string[]): void {
    for (const partialPath of paths) {
        if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
    }
}

interface WatchContext {
    jobId: number;
    mediaId: number;
}

interface WatchOptions {
    inactivityMs?: number;
    termGraceMs?: number;
    absoluteDeadlineMs: number;
    now?: () => number;
}

type WatchableChild = Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr" | "on" | "kill">;

export function watchFfmpegChild(
    child: WatchableChild,
    context: WatchContext,
    options: WatchOptions
): Promise<void> {
    const inactivityMs = options.inactivityMs ?? FFMPEG_INACTIVITY_TIMEOUT_MS;
    const termGraceMs = options.termGraceMs ?? FFMPEG_TERM_GRACE_MS;
    const now = options.now ?? Date.now;
    const startedAt = now();
    let lastProgressAt = startedAt;
    let progressBuffer = "";
    let stderrTail = "";
    let terminationReason: "inactivity" | "deadline" | null = null;
    let inactivityTimer: NodeJS.Timeout | null = null;
    let deadlineTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const releaseRegisteredChild = registerChildProcess(child as unknown as Parameters<typeof registerChildProcess>[0]);
    return new Promise((resolve, reject) => {
        const clearTimers = () => {
            if (inactivityTimer) clearTimeout(inactivityTimer);
            if (deadlineTimer) clearTimeout(deadlineTimer);
            if (killTimer) clearTimeout(killTimer);
        };
        const terminate = (reason: "inactivity" | "deadline") => {
            if (terminationReason) return;
            terminationReason = reason;
            const elapsed = now() - startedAt;
            const progressAge = now() - lastProgressAt;
            console.warn(
                `FFmpeg watchdog: job=${context.jobId} media=${context.mediaId} ` +
                `reason=${reason} elapsedMs=${elapsed} lastProgressAgeMs=${progressAge} stage=SIGTERM`
            );
            child.kill("SIGTERM");
            killTimer = setTimeout(() => {
                console.warn(`FFmpeg watchdog: job=${context.jobId} media=${context.mediaId} stage=SIGKILL`);
                child.kill("SIGKILL");
            }, termGraceMs);
        };
        const armInactivity = () => {
            if (inactivityTimer) clearTimeout(inactivityTimer);
            inactivityTimer = setTimeout(() => terminate("inactivity"), inactivityMs);
        };
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            progressBuffer += chunk;
            const lines = progressBuffer.split(/\r?\n/);
            progressBuffer = lines.pop() ?? "";
            if (lines.some((line) => /^(?:frame|out_time_ms|out_time_us|progress)=\S+/.test(line))) {
                lastProgressAt = now();
                armInactivity();
            }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            stderrTail = (stderrTail + chunk).slice(-16_384);
        });
        child.on("error", (error) => {
            clearTimers();
            releaseRegisteredChild();
            reject(error);
        });
        child.on("close", (code, signal) => {
            clearTimers();
            releaseRegisteredChild();
            if (terminationReason) {
                reject(new FfmpegWatchdogError(terminationReason));
            } else if (code === 0) {
                resolve();
            } else {
                reject(new Error(`FFmpeg nije uspeo (code=${code}, signal=${signal}): ${stderrTail.trim()}`));
            }
        });
        armInactivity();
        deadlineTimer = setTimeout(() => terminate("deadline"), options.absoluteDeadlineMs);
    });
}

export function runWatchedFfmpeg(
    args: string[],
    context: WatchContext,
    metadata: Partial<DeadlineMetadata>,
    testOptions: Partial<Omit<WatchOptions, "absoluteDeadlineMs">> = {}
): Promise<void> {
    const ffmpegArgs = ["-nostdin", "-nostats", "-progress", "pipe:1", ...args];
    const watchOptions = { absoluteDeadlineMs: calculateFfmpegDeadlineMs(metadata), ...testOptions };
    const child = spawn("nice", ["-n", "10", "ffmpeg", ...ffmpegArgs], { stdio: ["ignore", "pipe", "pipe"] });
    return watchFfmpegChild(child as unknown as WatchableChild, context, watchOptions).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        const fallback = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "pipe", "pipe"] });
        return watchFfmpegChild(fallback as unknown as WatchableChild, context, watchOptions);
    });
}
