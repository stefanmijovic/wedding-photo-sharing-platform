import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function startTestServer({ unlockAt, weddingAt }) {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wedding-app-test-"));
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
            TEST_EVENT_NOW_HEADER: "1",
            EVENT_UNLOCK_AT: unlockAt,
            WEDDING_AT: weddingAt
        },
        stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    let errorOutput = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
        errorOutput += chunk;
    });

    const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Test server se nije pokrenuo.\n${output}\n${errorOutput}`));
        }, 15_000);

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
            reject(new Error(`Test server je prerano završen (${code}).\n${output}\n${errorOutput}`));
        });
        child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
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

describe("zaključan događaj", () => {
    const unlockAt = "2099-10-10T08:00:00+02:00";
    const weddingAt = "2099-10-10T13:30:00+02:00";
    let server;

    before(async () => {
        server = await startTestServer({ unlockAt, weddingAt });
    });

    after(async () => {
        await server?.stop();
    });

    test("GET /api/health radi", async () => {
        const response = await fetch(`${server.baseUrl}/api/health`);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).status, "ok");
    });

    test("GET /api/event-config vraća validnu javnu konfiguraciju", async () => {
        const response = await fetch(`${server.baseUrl}/api/event-config`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { unlockAt, weddingAt });
    });

    test("POST /api/upload je odbijen pre otključavanja", async () => {
        const response = await fetch(`${server.baseUrl}/api/upload`, { method: "POST" });
        const body = await response.json();
        assert.equal(response.status, 403);
        assert.equal(body.code, "EVENT_LOCKED");
        assert.equal(body.unlockAt, unlockAt);
    });

    test("POST /api/voice-messages je odbijen pre Multer-a bez fajla, DB reda ili queue job-a", async () => {
        const form = new FormData();
        form.append("voice", new Blob(["not-a-real-audio-file"], { type: "audio/webm" }), "locked.webm");

        const response = await fetch(`${server.baseUrl}/api/voice-messages`, { method: "POST", body: form });
        const body = await response.json();
        assert.equal(response.status, 403);
        assert.equal(body.code, "EVENT_LOCKED");
        assert.equal(body.unlockAt, unlockAt);

        const incoming = path.join(server.dataRoot, "private", "voice-messages", "incoming");
        const processed = path.join(server.dataRoot, "private", "voice-messages", "processed");
        assert.deepEqual(await readdir(incoming), []);
        assert.deepEqual(await readdir(processed), []);

        const db = new Database(server.databasePath, { readonly: true });
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM voice_messages").get().count, 0);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM processing_jobs").get().count, 0);
        db.close();
    });

    for (const endpoint of ["/api/upload/image", "/api/upload/video"]) {
        test(`POST ${endpoint} je odbijen pre prihvatanja body-ja`, async () => {
            const response = await fetch(`${server.baseUrl}${endpoint}`, { method: "POST" });
            const body = await response.json();
            assert.equal(response.status, 403);
            assert.equal(body.code, "EVENT_LOCKED");
            assert.equal(body.unlockAt, unlockAt);
        });
    }

    test("GET /api/photos je odbijen pre otključavanja", async () => {
        const response = await fetch(`${server.baseUrl}/api/photos`);
        const body = await response.json();
        assert.equal(response.status, 403);
        assert.equal(body.code, "EVENT_LOCKED");
    });

    test("admin endpoint bez autentifikacije ostaje odbijen", async () => {
        const response = await fetch(`${server.baseUrl}/api/admin/photos`);
        assert.equal(response.status, 401);
    });
});

describe("EVENT_UNLOCK_AT granice i Europe/Belgrade vreme", () => {
    const unlockAt = "2030-06-15T08:00:00+02:00";
    let server;

    before(async () => {
        server = await startTestServer({
            unlockAt,
            weddingAt: "2030-06-15T14:00:00+02:00"
        });
    });

    after(async () => {
        await server?.stop();
    });

    for (const [label, now, expectedStatus] of [
        ["neposredno pre unlock-a je locked", "2030-06-15T07:59:59.999+02:00", 403],
        ["tačno u trenutku unlock-a je unlocked", unlockAt, 200],
        ["neposredno posle unlock-a je unlocked", "2030-06-15T08:00:00.001+02:00", 200]
    ]) {
        test(label, async () => {
            const response = await fetch(`${server.baseUrl}/api/photos`, {
                headers: { "x-test-event-now": now }
            });
            assert.equal(response.status, expectedStatus);
            if (expectedStatus === 403) assert.equal((await response.json()).code, "EVENT_LOCKED");
        });
    }

    test("eksplicitni +02:00 timestamp odgovara 08:00 Europe/Belgrade", () => {
        const timestamp = Date.parse(unlockAt);
        assert.equal(timestamp, Date.parse("2030-06-15T06:00:00.000Z"));
        assert.equal(new Intl.DateTimeFormat("en-GB", {
            timeZone: "Europe/Belgrade",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23"
        }).format(new Date(timestamp)), "08:00");
    });
});

describe("frontend event lock static coverage", () => {
    const projectRoot = path.resolve(backendRoot, "..");
    let indexSource;
    let uploadSource;
    let voiceSource;
    let translationsSource;

    before(async () => {
        [indexSource, uploadSource, voiceSource, translationsSource] = await Promise.all([
            readFile(path.join(projectRoot, "frontend/index.html"), "utf8"),
            readFile(path.join(projectRoot, "frontend/js/upload.js"), "utf8"),
            readFile(path.join(projectRoot, "frontend/js/voice-messages.js"), "utf8"),
            readFile(path.join(projectRoot, "frontend/js/translations.js"), "utf8")
        ]);
    });

    test("SR, EN i DE imaju kompletne upload/gallery/voice lock prevode", () => {
        for (const key of [
            "upload_locked_title", "upload_locked_message",
            "gallery_locked_title", "gallery_locked_message",
            "voice_locked_title", "voice_locked_message"
        ]) {
            assert.equal((translationsSource.match(new RegExp(`${key}:`, "g")) || []).length, 3, key);
        }
        assert.match(translationsSource, /Dodavanje fotografija i video snimaka još uvek nije dostupno\./);
        assert.match(translationsSource, /Photo and video uploads are not available yet\./);
        assert.match(translationsSource, /Das Hochladen von Fotos und Videos ist noch nicht verfügbar\./);
    });

    test("event-config.js se učitava pre upload.js i voice-messages.js", () => {
        const configIndex = indexSource.indexOf('src="js/event-config.js"');
        assert.ok(configIndex >= 0);
        assert.ok(configIndex < indexSource.indexOf('src="js/upload.js'));
        assert.ok(configIndex < indexSource.indexOf('src="js/voice-messages.js'));
    });

    test("image/video upload i galerija koriste server event config", () => {
        assert.match(uploadSource, /await window\.weddingEventConfig\.load\(\)/);
        assert.match(uploadSource, /window\.weddingEventConfig\.isUnlocked\(\)/);
        assert.match(uploadSource, /async function openGallerySection/);
        assert.match(uploadSource, /async function openUpload/);
        assert.match(uploadSource, /setupGalleryObserver/);
    });

    test("voice frontend koristi server event config", () => {
        assert.match(voiceSource, /await window\.weddingEventConfig\.load\(\)/);
        assert.match(voiceSource, /window\.weddingEventConfig\.isUnlocked\(\)/);
        assert.match(voiceSource, /body\?\.code === "EVENT_LOCKED"/);
    });
});

describe("otključan događaj", () => {
    let server;

    before(async () => {
        server = await startTestServer({
            unlockAt: "2020-10-10T08:00:00+02:00",
            weddingAt: "2020-10-10T13:30:00+02:00"
        });

        const db = new Database(server.databasePath);
        const insert = db.prepare(`
            INSERT INTO photos (
                filename,
                original_url,
                thumb_url,
                status,
                uploaded_at,
                ai_score,
                ai_reason,
                media_type,
                web_url,
                likes
            ) VALUES (?, ?, ?, ?, ?, 0, '', 'image', '', 0)
        `);

        insert.run("approved.jpg", "/uploads/original/approved.jpg", "/uploads/thumbs/approved.jpg", "approved", "2026-01-03T00:00:00.000Z");
        insert.run("hidden.jpg", "/uploads/original/hidden.jpg", "/uploads/thumbs/hidden.jpg", "hidden", "2026-01-02T00:00:00.000Z");
        insert.run("pending.jpg", "/uploads/original/pending.jpg", "/uploads/thumbs/pending.jpg", "pending_review", "2026-01-01T00:00:00.000Z");
        db.close();
    });

    after(async () => {
        await server?.stop();
    });

    test("GET /api/photos radi posle otključavanja i vraća samo javni sadržaj", async () => {
        const response = await fetch(`${server.baseUrl}/api/photos`);
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.total, 1);
        assert.deepEqual(body.photos.map((photo) => photo.filename), ["approved.jpg"]);
    });

    test("dupli like istog clientId-a ne povećava brojač drugi put", async () => {
        const galleryResponse = await fetch(`${server.baseUrl}/api/photos`);
        const photoId = (await galleryResponse.json()).photos[0].id;
        const request = () => fetch(`${server.baseUrl}/api/photos/${photoId}/like`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientId: "test-client-id-1234567890" })
        });

        const first = await request();
        const second = await request();
        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.equal((await first.json()).likes, 1);
        assert.equal((await second.json()).likes, 1);

        const db = new Database(server.databasePath, { readonly: true });
        assert.equal(db.prepare("SELECT likes FROM photos WHERE id = ?").get(photoId).likes, 1);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM photo_likes WHERE photo_id = ?").get(photoId).count, 1);
        db.close();
    });
});
