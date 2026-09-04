import { execFile } from "child_process";
import { registerChildProcess } from "./child-process-registry.js";

export const VIDEO_PROBE_TIMEOUT_MS = 120_000;
export const VIDEO_PROBE_MAX_BUFFER = 1024 * 1024;
export const MAX_VIDEO_LONG_EDGE = 8192;
export const MAX_VIDEO_SHORT_EDGE = 4320;
export const MAX_VIDEO_FPS = 240;
export const MAX_VIDEO_STREAMS = 8;

export interface VideoMetadata {
    durationSeconds: number;
    width: number;
    height: number;
    fps: number;
    streamCount: number;
    videoStreamCount: number;
    hasAudio: boolean;
    codecName: string;
    formatName: string;
}

export class VideoValidationError extends Error {
    constructor(public readonly code: "INVALID_VIDEO" | "UNSUPPORTED_VIDEO" | "VIDEO_METADATA_INVALID") {
        super(code);
    }
}

function finitePositive(value: unknown): number | null {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

export function parseFrameRate(value: unknown): number | null {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const text = String(value).trim();
    const match = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(text);
    if (match) {
        const numerator = Number(match[1]);
        const denominator = Number(match[2]);
        return denominator > 0 && Number.isFinite(numerator / denominator) && numerator / denominator > 0
            ? numerator / denominator
            : null;
    }
    return finitePositive(text);
}

export function validateVideoProbe(probe: unknown): VideoMetadata {
    if (!probe || typeof probe !== "object") throw new VideoValidationError("INVALID_VIDEO");
    const record = probe as { streams?: unknown; format?: unknown };
    if (!Array.isArray(record.streams) || record.streams.length === 0) {
        throw new VideoValidationError("INVALID_VIDEO");
    }
    if (record.streams.length > MAX_VIDEO_STREAMS) throw new VideoValidationError("UNSUPPORTED_VIDEO");

    const streams = record.streams as Array<Record<string, unknown>>;
    if (streams.some((stream) => stream.codec_type === "attachment" || stream.codec_type === "data")) {
        throw new VideoValidationError("UNSUPPORTED_VIDEO");
    }
    const videoStreams = streams.filter((stream) => stream.codec_type === "video");
    if (videoStreams.length === 0) throw new VideoValidationError("INVALID_VIDEO");
    const video = videoStreams[0]!;
    const width = finitePositive(video.width);
    const height = finitePositive(video.height);
    if (!width || !height || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
        throw new VideoValidationError("VIDEO_METADATA_INVALID");
    }
    const longEdge = Math.max(width, height);
    const shortEdge = Math.min(width, height);
    if (longEdge > MAX_VIDEO_LONG_EDGE || shortEdge > MAX_VIDEO_SHORT_EDGE) {
        throw new VideoValidationError("UNSUPPORTED_VIDEO");
    }

    const fps = parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate);
    if (!fps) throw new VideoValidationError("VIDEO_METADATA_INVALID");
    if (fps > MAX_VIDEO_FPS) throw new VideoValidationError("UNSUPPORTED_VIDEO");

    const format = record.format && typeof record.format === "object"
        ? record.format as Record<string, unknown>
        : {};
    const duration = finitePositive(format.duration) ?? finitePositive(video.duration);
    if (!duration) throw new VideoValidationError("VIDEO_METADATA_INVALID");
    const formatName = typeof format.format_name === "string" ? format.format_name.trim() : "";
    const codecName = typeof video.codec_name === "string" ? video.codec_name.trim() : "";
    if (!formatName || !codecName || codecName === "unknown" || /^(?:data|image2|image2pipe)$/.test(formatName)) {
        throw new VideoValidationError("UNSUPPORTED_VIDEO");
    }

    return {
        durationSeconds: duration,
        width,
        height,
        fps,
        streamCount: streams.length,
        videoStreamCount: videoStreams.length,
        hasAudio: streams.some((stream) => stream.codec_type === "audio"),
        codecName,
        formatName
    };
}

export function parseVideoProbeJson(stdout: string): VideoMetadata {
    try {
        return validateVideoProbe(JSON.parse(stdout));
    } catch (error) {
        throw error instanceof VideoValidationError ? error : new VideoValidationError("INVALID_VIDEO");
    }
}

export function probeVideoInput(filePath: string): Promise<VideoMetadata> {
    return new Promise((resolve, reject) => {
        const child = execFile(
            "ffprobe",
            [
                "-v", "error",
                "-show_format",
                "-show_streams",
                "-of", "json",
                filePath
            ],
            { timeout: VIDEO_PROBE_TIMEOUT_MS, maxBuffer: VIDEO_PROBE_MAX_BUFFER },
            (error, stdout) => {
                if (error) {
                    reject(new VideoValidationError("INVALID_VIDEO"));
                    return;
                }
                try {
                    resolve(parseVideoProbeJson(stdout));
                } catch (validationError) {
                    reject(validationError);
                }
            }
        );
        registerChildProcess(child);
    });
}
