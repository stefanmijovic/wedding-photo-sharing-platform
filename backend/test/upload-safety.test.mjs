import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import Database from "better-sqlite3";
import sharp from "sharp";
import {
    IMAGE_UPLOAD_LIMIT,
    VIDEO_UPLOAD_LIMIT,
    imageDimensionViolation
} from "../dist/upload-safety.js";

const execFileAsync = promisify(execFile);
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function startTestServer() {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wedding-upload-test-"));
    const child = spawn(process.execPath, ["dist/server.js"], {
        cwd: backendRoot,
        env: {
            ...process.env,
            NODE_ENV: "test",
            PORT: "0",
            TEST_DATA_ROOT: dataRoot,
            TEST_DISABLE_PROCESSING_WORKER: "1",
            TEST_SKIP_AI_MODERATION: "1",
            SESSION_SECRET: "test-session-secret-at-least-32-characters-long",
            ADMIN_EMAIL: "admin@example.test",
            ADMIN_PANEL_URL: "http://localhost/admin.html",
            DEFAULT_ADMIN_USERNAME: "test-admin",
            DEFAULT_ADMIN_PASSWORD: "test-password-at-least-12-characters",
            EVENT_UNLOCK_AT: "2020-10-10T08:00:00+02:00",
            WEDDING_AT: "2020-10-10T13:30:00+02:00"
        },
        stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Server timeout\n${stdout}\n${stderr}`)), 15_000);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            const match = stdout.match(/Server radi na portu (\d+)/);
            if (match) {
                clearTimeout(timeout);
                resolve(Number(match[1]));
            }
        });
        child.once("exit", (code) => reject(new Error(`Server exit ${code}\n${stdout}\n${stderr}`)));
        child.once("error", reject);
    });
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        dataRoot,
        databasePath: path.join(dataRoot, "database.sqlite"),
        diagnostics: () => stderr,
        async stop() {
            if (child.exitCode === null) {
                child.kill("SIGTERM");
                await new Promise((resolve) => child.once("exit", resolve));
            }
            await rm(dataRoot, { recursive: true, force: true });
        }
    };
}

async function upload(baseUrl, endpoint, bytes, name, type) {
    const form = new FormData();
    form.append("photo", new Blob([bytes], { type }), name);
    return fetch(`${baseUrl}${endpoint}`, { method: "POST", body: form });
}

async function fileTree(root) {
    const results = [];
    async function walk(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) await walk(absolute);
            else results.push(path.relative(root, absolute));
        }
    }
    await walk(root);
    return results.sort();
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const typeBytes = Buffer.from(type, "ascii");
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    typeBytes.copy(chunk, 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
    return chunk;
}

function dimensionOnlyPng(width, height) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    const firstScanline = Buffer.alloc(1 + width * 3);
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", deflateSync(firstScanline)),
        pngChunk("IEND", Buffer.alloc(0))
    ]);
}

describe("Phase 1B upload classification and image safety", () => {
    let server;
    let fixtures;
    let hasFfmpeg = false;

    before(async () => {
        server = await startTestServer();
        const source = sharp({ create: { width: 1200, height: 1600, channels: 3, background: "#6f4e82" } });
        fixtures = {
            jpeg: await source.clone().jpeg().toBuffer(),
            png: await source.clone().png().toBuffer(),
            webp: await source.clone().webp().toBuffer(),
            gif: await source.clone().gif().toBuffer()
        };
        const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "wedding-heic-fixture-"));
        const jpegPath = path.join(fixtureRoot, "source.jpg");
        const heicPath = path.join(fixtureRoot, "source.heic");
        const videoPath = path.join(fixtureRoot, "source.mp4");
        const audioOnlyPath = path.join(fixtureRoot, "audio-only.mp4");
        await writeFile(jpegPath, fixtures.jpeg);
        try {
            await execFileAsync("ffmpeg", ["-version"]);
            hasFfmpeg = true;
            await execFileAsync("ffmpeg", [
                "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=1920x1080:r=30",
                "-t", "0.25", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-y", videoPath
            ]);
            await execFileAsync("ffmpeg", [
                "-v", "error", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
                "-t", "0.25", "-c:a", "aac", "-vn", "-y", audioOnlyPath
            ]);
            fixtures.video = await readFile(videoPath);
            fixtures.audioOnly = await readFile(audioOnlyPath);
        } catch {
            fixtures.video = null;
            fixtures.audioOnly = null;
        }
        try {
            await execFileAsync("heif-enc", [jpegPath, "-o", heicPath]);
            fixtures.heic = await readFile(heicPath);
        } catch {
            fixtures.heic = null;
        } finally {
            await rm(fixtureRoot, { recursive: true, force: true });
        }
    });

    after(async () => { await server?.stop(); });

    for (const [label, extension, mime] of [
        ["JPEG", "jpg", "image/jpeg"],
        ["PNG", "png", "image/png"],
        ["WebP", "webp", "image/webp"],
        ["GIF", "gif", "image/gif"],
        ["HEIC", "heic", "image/heic"]
    ]) {
        test(`${label} image endpoint prihvata stvarno dekodiran format`, async (context) => {
            if (!fixtures[label.toLowerCase()]) {
                context.skip("Host nema HEVC encoder za generisanje izolovanog HEIC fixture-a.");
                return;
            }
            const response = await upload(server.baseUrl, "/api/upload/image", fixtures[label.toLowerCase()], `photo.${extension}`, mime);
            assert.equal(response.status, 200, `${await response.text()}\n${server.diagnostics()}`);
        });
    }

    test("legacy endpoint prihvata validnu sliku", async () => {
        assert.equal((await upload(server.baseUrl, "/api/upload", fixtures.jpeg, "legacy.jpg", "image/jpeg")).status, 200);
    });

    test("legacy endpoint odbija video uz compatibility code", async () => {
        const response = await upload(server.baseUrl, "/api/upload", Buffer.from("nominal-video"), "clip.mp4", "video/mp4");
        assert.equal(response.status, 415);
        assert.equal((await response.json()).code, "VIDEO_USE_VIDEO_ENDPOINT");
    });

    test("image endpoint odbija video kao nepodržan image tip", async () => {
        const response = await upload(server.baseUrl, "/api/upload/image", Buffer.from("nominal-video"), "clip.mp4", "video/mp4");
        assert.equal(response.status, 415);
        assert.equal((await response.json()).code, "UNSUPPORTED_IMAGE_TYPE");
    });

    test("video endpoint odbija sliku", async () => {
        const response = await upload(server.baseUrl, "/api/upload/video", fixtures.jpeg, "photo.jpg", "image/jpeg");
        assert.equal(response.status, 415);
        assert.equal((await response.json()).code, "UNSUPPORTED_VIDEO_TYPE");
    });

    test("validan nominalni video čuva kompatibilan DB i queued job", async (context) => {
        if (!hasFfmpeg) {
            context.skip("FFmpeg/ffprobe nisu dostupni na hostu za generisanje izolovanog video fixture-a.");
            return;
        }
        const response = await upload(server.baseUrl, "/api/upload/video", fixtures.video, "clip.mp4", "video/mp4");
        assert.equal(response.status, 200, await response.text());
        const db = new Database(server.databasePath, { readonly: true });
        const video = db.prepare("SELECT id,media_type,status,original_url FROM photos WHERE media_type='video' ORDER BY id DESC LIMIT 1").get();
        const job = db.prepare("SELECT status,job_type FROM processing_jobs WHERE target_type='photo' AND target_id=?").get(video.id);
        db.close();
        assert.equal(video.media_type, "video");
        assert.equal(video.status, "pending_review");
        assert.match(video.original_url, /^\/uploads\/videos\/original\/[0-9a-f-]+\.mp4$/);
        assert.deepEqual(job, { status: "queued", job_type: "video_process" });
    });

    for (const [label, bytes, name] of [
        ["corrupt MP4", Buffer.from([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]), "corrupt.mp4"],
        ["random bytes MP4", Buffer.from("this-is-not-video"), "random.mp4"],
        ["image maskiran kao MP4", null, "masked.mp4"],
        ["MP4 bez video streama", null, "audio-only.mp4"]
    ]) {
        test(`${label} se odbija pre DB/enqueue i čisti original`, async (context) => {
            if (label.startsWith("MP4") && !hasFfmpeg) {
                context.skip("FFmpeg nije dostupan za audio-only MP4 fixture.");
                return;
            }
            const uploadRoot = path.join(server.dataRoot, "uploads");
            const beforeFiles = await fileTree(uploadRoot);
            const dbBefore = new Database(server.databasePath, { readonly: true });
            const mediaBefore = dbBefore.prepare("SELECT COUNT(*) AS count FROM photos").get().count;
            const jobsBefore = dbBefore.prepare("SELECT COUNT(*) AS count FROM processing_jobs").get().count;
            dbBefore.close();
            const payload = label.startsWith("image") ? fixtures.jpeg : label.startsWith("MP4") ? fixtures.audioOnly : bytes;
            const response = await upload(server.baseUrl, "/api/upload/video", payload, name, "video/mp4");
            assert.equal(response.status, 422);
            assert.ok(["INVALID_VIDEO", "VIDEO_METADATA_INVALID", "UNSUPPORTED_VIDEO"].includes((await response.json()).code));
            const dbAfter = new Database(server.databasePath, { readonly: true });
            assert.equal(dbAfter.prepare("SELECT COUNT(*) AS count FROM photos").get().count, mediaBefore);
            assert.equal(dbAfter.prepare("SELECT COUNT(*) AS count FROM processing_jobs").get().count, jobsBefore);
            dbAfter.close();
            assert.deepEqual(await fileTree(uploadRoot), beforeFiles);
        });
    }

    test("binary MiB/GiB konstante i overflow-safe 100 MP granica", () => {
        assert.equal(IMAGE_UPLOAD_LIMIT, 30 * 1024 * 1024);
        assert.equal(VIDEO_UPLOAD_LIMIT, 1024 * 1024 * 1024);
        assert.equal(imageDimensionViolation(10_000, 10_000), null);
        assert.equal(imageDimensionViolation(10_001, 10_000), "pixels");
        assert.equal(imageDimensionViolation(16_385, 1), "width");
        assert.equal(imageDimensionViolation(1, 16_385), "height");
        assert.equal(imageDimensionViolation(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), "width");
    });

    test("slika tačno 30 MiB prolazi Multer size gate", async () => {
        const padded = Buffer.concat([fixtures.jpeg, Buffer.alloc(IMAGE_UPLOAD_LIMIT - fixtures.jpeg.length)]);
        const response = await upload(server.baseUrl, "/api/upload/image", padded, "boundary.jpg", "image/jpeg");
        assert.equal(response.status, 200, await response.text());
    });

    test("slika preko 30 MiB vraća IMAGE_TOO_LARGE i ne ostavlja orphan", async () => {
        const before = await fileTree(path.join(server.dataRoot, "uploads"));
        const oversized = Buffer.alloc(IMAGE_UPLOAD_LIMIT + 1);
        const response = await upload(server.baseUrl, "/api/upload/image", oversized, "large.jpg", "image/jpeg");
        assert.equal(response.status, 413);
        assert.equal((await response.json()).code, "IMAGE_TOO_LARGE");
        assert.deepEqual(await fileTree(path.join(server.dataRoot, "uploads")), before);
    });

    for (const [label, bytes, name, mime, expectedCode] of [
        ["fake jpg", Buffer.from("not-an-image"), "fake.jpg", "image/jpeg", "INVALID_IMAGE"],
        ["truncated JPEG", Buffer.from([0xff, 0xd8, 0xff, 0xdb]), "truncated.jpg", "image/jpeg", "INVALID_IMAGE"],
        ["HEIC conversion failure", Buffer.from("not-heic"), "broken.heic", "image/heic", "INVALID_IMAGE"],
        ["MIME/extension spoof", null, "spoof.jpg", "image/jpeg", "INVALID_IMAGE"],
        ["unsupported type", Buffer.from("bmp"), "photo.bmp", "image/bmp", "UNSUPPORTED_IMAGE_TYPE"]
    ]) {
        test(`${label} se odbija bez orphan fajlova`, async () => {
            const before = await fileTree(path.join(server.dataRoot, "uploads"));
            const response = await upload(server.baseUrl, "/api/upload/image", bytes ?? fixtures.png, name, mime);
            assert.ok([415, 422].includes(response.status));
            assert.equal((await response.json()).code, expectedCode);
            assert.deepEqual(await fileTree(path.join(server.dataRoot, "uploads")), before);
        });
    }

    for (const [label, width, height] of [
        ["preširoka", 16_385, 1],
        ["previsoka", 1, 16_385],
        ["preko 100 MP", 10_001, 10_000]
    ]) {
        test(`${label} PNG se odbija bez orphan fajlova`, async () => {
            const before = await fileTree(path.join(server.dataRoot, "uploads"));
            const response = await upload(server.baseUrl, "/api/upload/image", dimensionOnlyPng(width, height), `${label}.png`, "image/png");
            assert.equal(response.status, 422);
            assert.equal((await response.json()).code, "IMAGE_DIMENSIONS_EXCEEDED");
            assert.deepEqual(await fileTree(path.join(server.dataRoot, "uploads")), before);
        });
    }
});
