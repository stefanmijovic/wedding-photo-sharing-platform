import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcrypt";
import Database from "better-sqlite3";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowedOrigin = "http://localhost";
const adminPassword = "test-password-at-least-12-characters";

async function startTestServer() {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wedding-auth-test-"));
    const child = spawn(process.execPath, ["dist/server.js"], {
        cwd: backendRoot,
        env: {
            ...process.env,
            NODE_ENV: "test",
            PORT: "0",
            TEST_DATA_ROOT: dataRoot,
            TEST_DISABLE_PROCESSING_WORKER: "1",
            SESSION_SECRET: "test-session-secret-at-least-32-characters-long",
            ADMIN_EMAIL: "admin@example.test",
            ADMIN_PANEL_URL: "http://localhost/admin.html",
            DEFAULT_ADMIN_USERNAME: "test-admin",
            DEFAULT_ADMIN_PASSWORD: adminPassword,
            EVENT_UNLOCK_AT: "2020-10-10T08:00:00+02:00",
            WEDDING_AT: "2020-10-10T13:30:00+02:00"
        },
        stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    let errorOutput = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { errorOutput += chunk; });

    const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Test server se nije pokrenuo.\n${output}\n${errorOutput}`)), 15_000);
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
        child.once("error", reject);
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

function cookieFrom(response) {
    const value = response.headers.get("set-cookie");
    assert.ok(value, "login mora vratiti session cookie");
    return value.split(";", 1)[0];
}

async function login(baseUrl, username, password = adminPassword) {
    const response = await fetch(`${baseUrl}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: allowedOrigin },
        body: JSON.stringify({ username, password })
    });
    assert.equal(response.status, 200);
    return cookieFrom(response);
}

function requestMedia(baseUrl, filename, cookie) {
    return fetch(`${baseUrl}/uploads/original/${filename}`, {
        headers: cookie ? { Cookie: cookie } : undefined
    });
}

describe("private media authorization", () => {
    let server;
    let adminCookie;
    let coupleCookie;
    let deletedCookie;
    let invalidRoleCookie;

    before(async () => {
        server = await startTestServer();
        const mediaDir = path.join(server.dataRoot, "uploads", "original");
        await mkdir(mediaDir, { recursive: true });

        const media = [
            ["approved.jpg", "approved"],
            ["pending.jpg", "pending_review"],
            ["hidden.jpg", "hidden"]
        ];
        for (const [filename] of media) await writeFile(path.join(mediaDir, filename), filename);

        const db = new Database(server.databasePath);
        const insertPhoto = db.prepare(`
            INSERT INTO photos (filename, original_url, thumb_url, status, uploaded_at, ai_score, ai_reason, media_type, web_url, likes)
            VALUES (?, ?, ?, ?, ?, 0, '', 'image', '', 0)
        `);
        for (const [filename, status] of media) {
            insertPhoto.run(filename, `/uploads/original/${filename}`, `/uploads/thumbs/${filename}`, status, new Date().toISOString());
        }

        const passwordHash = bcrypt.hashSync(adminPassword, 4);
        const insertUser = db.prepare("INSERT INTO admins (username, password_hash, created_at, role) VALUES (?, ?, ?, ?)");
        insertUser.run("test-couple", passwordHash, new Date().toISOString(), "couple");
        insertUser.run("test-deleted", passwordHash, new Date().toISOString(), "admin");
        insertUser.run("test-invalid-role", passwordHash, new Date().toISOString(), "admin");
        db.close();

        adminCookie = await login(server.baseUrl, "test-admin");
        coupleCookie = await login(server.baseUrl, "test-couple");
        deletedCookie = await login(server.baseUrl, "test-deleted");
        invalidRoleCookie = await login(server.baseUrl, "test-invalid-role");

        const mutationDb = new Database(server.databasePath);
        mutationDb.prepare("DELETE FROM admins WHERE username = 'test-deleted'").run();
        mutationDb.prepare("UPDATE admins SET role = 'viewer' WHERE username = 'test-invalid-role'").run();
        mutationDb.close();
    });

    after(async () => { await server?.stop(); });

    for (const [label, cookie] of [
        ["anonymous", undefined],
        ["admin", () => adminCookie],
        ["couple", () => coupleCookie]
    ]) {
        test(`approved media: ${label} dobija fajl`, async () => {
            const response = await requestMedia(server.baseUrl, "approved.jpg", typeof cookie === "function" ? cookie() : cookie);
            assert.equal(response.status, 200);
        });
    }

    for (const status of ["pending", "hidden"]) {
        test(`${status} media: anonymous dobija 404`, async () => {
            assert.equal((await requestMedia(server.baseUrl, `${status}.jpg`)).status, 404);
        });
        test(`${status} media: valid admin dobija fajl`, async () => {
            assert.equal((await requestMedia(server.baseUrl, `${status}.jpg`, adminCookie)).status, 200);
        });
        test(`${status} media: valid couple dobija fajl`, async () => {
            assert.equal((await requestMedia(server.baseUrl, `${status}.jpg`, coupleCookie)).status, 200);
        });
        test(`${status} media: session obrisanog korisnika dobija 404`, async () => {
            assert.equal((await requestMedia(server.baseUrl, `${status}.jpg`, deletedCookie)).status, 404);
        });
        test(`${status} media: session korisnika sa invalidnom rolom dobija 404`, async () => {
            assert.equal((await requestMedia(server.baseUrl, `${status}.jpg`, invalidRoleCookie)).status, 404);
        });
    }

    test("requireAdmin prihvata admin i couple, a odbija stale/invalid session", async () => {
        assert.equal((await fetch(`${server.baseUrl}/api/admin/me`, { headers: { Cookie: adminCookie } })).status, 200);
        assert.equal((await fetch(`${server.baseUrl}/api/admin/me`, { headers: { Cookie: coupleCookie } })).status, 200);
        assert.equal((await fetch(`${server.baseUrl}/api/admin/me`, { headers: { Cookie: deletedCookie } })).status, 401);
        assert.equal((await fetch(`${server.baseUrl}/api/admin/me`, { headers: { Cookie: invalidRoleCookie } })).status, 401);
    });

    test("requireCouple i private voice ostaju couple-only", async () => {
        assert.equal((await fetch(`${server.baseUrl}/api/couple/voice-messages`, { headers: { Cookie: coupleCookie } })).status, 200);
        assert.equal((await fetch(`${server.baseUrl}/api/couple/voice-messages`, { headers: { Cookie: adminCookie } })).status, 403);
        assert.equal((await fetch(`${server.baseUrl}/api/couple/voice-messages`)).status, 401);
    });

    test("admin logout invalidira session", async () => {
        const logoutCookie = await login(server.baseUrl, "test-admin");
        const response = await fetch(`${server.baseUrl}/api/admin/logout`, {
            method: "POST",
            headers: { Cookie: logoutCookie, Origin: allowedOrigin }
        });
        assert.equal(response.status, 200);
        assert.equal((await fetch(`${server.baseUrl}/api/admin/me`, { headers: { Cookie: logoutCookie } })).status, 401);
    });
});
