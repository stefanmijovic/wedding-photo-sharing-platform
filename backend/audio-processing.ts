import fs from "fs";
import { execFile } from "child_process";

export interface AudioMetadata {
    durationSeconds: number;
    channels: number;
    sampleRate: number;
    codecName: string;
    formatName: string;
    sizeBytes: number;
}

interface ProbeOutput {
    streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        channels?: number;
        sample_rate?: string;
        duration?: string;
    }>;
    format?: {
        format_name?: string;
        duration?: string;
        size?: string;
    };
}

interface PacketProbeOutput {
    packets?: Array<{
        pts_time?: string;
        duration_time?: string;
    }>;
}

function runProgram(program: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile(program, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                const safeStderr = stderr.replace(/\s+/g, " ").trim().slice(0, 1000);
                reject(new Error(`${program} nije uspeo: ${safeStderr || error.message}`, { cause: error }));
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

export function hasRecognizedAudioSignature(filePath: string): boolean {
    const handle = fs.openSync(filePath, "r");
    try {
        const header = Buffer.alloc(16);
        const bytesRead = fs.readSync(handle, header, 0, header.length, 0);
        if (bytesRead < 4) return false;
        return (
            header.subarray(0, 4).toString("ascii") === "OggS" ||
            header.subarray(0, 4).toString("ascii") === "RIFF" ||
            header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ||
            (bytesRead >= 12 && header.subarray(4, 8).toString("ascii") === "ftyp")
        );
    } finally {
        fs.closeSync(handle);
    }
}

export async function probeAudio(filePath: string): Promise<AudioMetadata> {
    const { stdout } = await runProgram("ffprobe", [
        "-v", "error",
        "-show_format",
        "-show_streams",
        "-print_format", "json",
        filePath
    ], 30_000);
    let parsed: ProbeOutput;
    try {
        parsed = JSON.parse(stdout) as ProbeOutput;
    } catch (error) {
        throw new Error("FFprobe nije vratio validan JSON.", { cause: error });
    }
    const streams = parsed.streams ?? [];
    const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
    if (audioStreams.length === 0) throw new Error("Fajl nema audio stream.");
    if (streams.some((stream) => stream.codec_type === "video")) throw new Error("Glasovna poruka ne sme sadržati video stream.");
    const audio = audioStreams[0]!;
    let durationSeconds = Number(parsed.format?.duration ?? audio.duration);
    // MediaRecorder WebM files frequently omit container and stream duration.
    // In that case derive it from decoded audio packet timestamps without
    // trusting client-provided metadata.
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        const { stdout: packetStdout } = await runProgram("ffprobe", [
            "-v", "error",
            "-select_streams", "a:0",
            "-show_packets",
            "-show_entries", "packet=pts_time,duration_time",
            "-print_format", "json",
            filePath
        ], 30_000);
        let packetProbe: PacketProbeOutput;
        try {
            packetProbe = JSON.parse(packetStdout) as PacketProbeOutput;
        } catch (error) {
            throw new Error("FFprobe nije vratio validne audio pakete.", { cause: error });
        }
        durationSeconds = (packetProbe.packets ?? []).reduce((maximum, packet) => {
            const pts = Number(packet.pts_time);
            const packetDuration = Number(packet.duration_time);
            if (!Number.isFinite(pts)) return maximum;
            const end = pts + (Number.isFinite(packetDuration) && packetDuration > 0 ? packetDuration : 0);
            return Math.max(maximum, end);
        }, 0);
    }
    const channels = Number(audio.channels);
    const sampleRate = Number(audio.sample_rate);
    const sizeBytes = Number(parsed.format?.size ?? fs.statSync(filePath).size);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("Trajanje audio fajla nije validno.");
    if (!Number.isInteger(channels) || channels < 1 || channels > 2) throw new Error("Audio mora imati jedan ili dva kanala.");
    if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) throw new Error("Sample rate nije podržan.");
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) throw new Error("Audio fajl je prazan.");
    return {
        durationSeconds,
        channels,
        sampleRate,
        codecName: audio.codec_name ?? "unknown",
        formatName: parsed.format?.format_name ?? "unknown",
        sizeBytes
    };
}

export function validateVoiceMetadata(metadata: AudioMetadata): void {
    if (metadata.durationSeconds < 0.9) throw new Error("Glasovna poruka mora trajati najmanje 1 sekundu.");
    if (metadata.durationSeconds > 121) throw new Error("Glasovna poruka ne sme biti duža od 120 sekundi.");
}

export async function verifyAudioDecodable(filePath: string): Promise<void> {
    await runProgram("ffmpeg", [
        "-v", "error", "-i", filePath,
        "-map", "0:a:0", "-vn", "-f", "null", "-"
    ], 150_000);
}

export async function normalizeVoiceToM4a(inputPath: string, outputPath: string): Promise<void> {
    await runProgram("ffmpeg", [
        "-y", "-i", inputPath,
        "-map", "0:a:0", "-vn", "-map_metadata", "-1",
        "-ac", "1", "-ar", "48000", "-c:a", "aac", "-b:a", "64k",
        "-movflags", "+faststart", "-f", "mp4", outputPath
    ], 180_000);
}
