import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const voiceBytes = (marker = "VALID") => Buffer.concat([EBML, Buffer.from(marker)]);

async function startServer(extraEnv = {}, existingRoot) {
    const dataRoot = existingRoot || await mkdtemp(path.join(os.tmpdir(), "wedding-voice-test-"));
    const child = spawn(process.execPath, ["dist/server.js"], {
        cwd: backendRoot,
        env: {
            ...process.env,
            NODE_ENV: "test", PORT: "0", TEST_DATA_ROOT: dataRoot,
            SESSION_SECRET: "test-session-secret-at-least-32-characters-long",
            ADMIN_EMAIL: "admin@example.test", ADMIN_PANEL_URL: "http://localhost/admin.html",
            DEFAULT_ADMIN_USERNAME: "test-admin", DEFAULT_ADMIN_PASSWORD: "test-password-at-least-12-characters",
            EVENT_UNLOCK_AT: "2020-10-10T08:00:00+02:00", WEDDING_AT: "2020-10-10T13:30:00+02:00",
            TEST_SKIP_AI_MODERATION: "1", TEST_VOICE_PROCESSOR: "stub",
            ...extraEnv
        },
        stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "", errors = "";
    child.stderr.setEncoding("utf8"); child.stderr.on("data", (value) => { errors += value; });
    const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Server timeout\n${output}\n${errors}`)), 15_000);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (value) => {
            output += value;
            const match = /Server radi na portu (\d+)/.exec(output);
            if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
        });
        child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Server exit ${code}\n${output}\n${errors}`)); });
    });
    return {
        baseUrl: `http://127.0.0.1:${port}`, dataRoot, child,
        databasePath: path.join(dataRoot, "database.sqlite"),
        incoming: path.join(dataRoot, "private", "voice-messages", "incoming"),
        processed: path.join(dataRoot, "private", "voice-messages", "processed"),
        async stop(removeRoot = true) {
            if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); }
            if (removeRoot) await rm(dataRoot, { recursive: true, force: true });
        }
    };
}
async function upload(server, marker = "VALID", senderName, filename = "voice.webm") {
    const form = new FormData();
    form.append("voice", new Blob([voiceBytes(marker)], { type: "audio/webm" }), filename);
    if (senderName !== undefined) form.append("sender_name", senderName);
    return fetch(`${server.baseUrl}/api/voice-messages`, { method: "POST", body: form });
}

function createCouple(server) {
    const db = new Database(server.databasePath);
    const admin = db.prepare("SELECT password_hash FROM admins WHERE username = 'test-admin'").get();
    db.prepare("INSERT INTO admins (username, password_hash, role, created_at) VALUES ('test-couple', ?, 'couple', ?)")
        .run(admin.password_hash, new Date().toISOString());
    db.close();
}

async function login(server, username = "test-admin") {
    const response = await fetch(`${server.baseUrl}/api/admin/login`, {
        method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        body: JSON.stringify({ username, password: "test-password-at-least-12-characters" })
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";", 1)[0];
}

async function waitFor(check, timeout = 5_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const result = check();
        if (result) return result;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Uslov nije ispunjen na vreme.");
}

describe("voice event lock i upload validacija", () => {
    let locked, server;
    before(async () => {
        locked = await startServer({ EVENT_UNLOCK_AT: "2099-10-10T08:00:00+02:00", WEDDING_AT: "2099-10-10T13:30:00+02:00" });
        server = await startServer({ TEST_DISABLE_PROCESSING_WORKER: "1" });
    });
    after(async () => { await locked?.stop(); await server?.stop(); });

    test("event lock vraća 403 pre Multera i ne pravi incoming fajl", async () => {
        const beforeFiles = readdirSync(locked.incoming).length;
        const response = await upload(locked);
        assert.equal(response.status, 403);
        assert.equal((await response.json()).code, "EVENT_LOCKED");
        assert.equal(readdirSync(locked.incoming).length, beforeFiles);
    });
    test("više fajlova je odbijeno i očišćeno", async () => {
        const form = new FormData();
        form.append("voice", new Blob([voiceBytes()], { type: "audio/webm" }), "one.webm");
        form.append("voice", new Blob([voiceBytes()], { type: "audio/webm" }), "two.webm");
        const response = await fetch(`${server.baseUrl}/api/voice-messages`, { method: "POST", body: form });
        assert.equal(response.status, 400);
        assert.equal(readdirSync(server.incoming).length, 0);
    });
    test("fajl preko 25 MB vraća 413 i ne ostaje na disku", async () => {
        const form = new FormData();
        form.append("voice", new Blob([Buffer.alloc(25 * 1024 * 1024 + 1)], { type: "audio/webm" }), "large.webm");
        const response = await fetch(`${server.baseUrl}/api/voice-messages`, { method: "POST", body: form });
        assert.equal(response.status, 413);
        assert.equal(readdirSync(server.incoming).length, 0);
    });
    for (const [label, marker] of [["corrupt audio", "CORRUPT"], ["video stream", "VIDEO"], ["preduga poruka", "LONG"], ["prekratka poruka", "SHORT"]]) {
        test(`${label} se odbija i čisti`, async () => {
            const response = await upload(server, marker);
            assert.equal(response.status, 422);
            assert.equal(readdirSync(server.incoming).length, 0);
        });
    }
    test("validan upload vraća 202 i atomarno kreira voice i jedinstveni job", async () => {
        const response = await upload(server, "VALID", "  Marko/../Petrović  ");
        assert.equal(response.status, 202);
        assert.deepEqual(await response.json(), { success: true, status: "processing", message: "Glasovna poruka je primljena." });
        const db = new Database(server.databasePath, { readonly: true });
        const voice = db.prepare("SELECT * FROM voice_messages").get();
        const jobs = db.prepare("SELECT * FROM processing_jobs WHERE target_type = 'voice_message' AND target_id = ?").all(voice.id);
        assert.equal(voice.sender_name, "Marko/../Petrović");
        assert.equal(jobs.length, 1); assert.equal(jobs[0].job_type, "voice_normalize"); assert.equal(jobs[0].status, "queued");
        assert.throws(() => db.prepare("INSERT INTO processing_jobs (target_type,target_id,job_type,status,max_attempts,available_at,created_at) VALUES ('voice_message',?,'voice_normalize','queued',4,?,?)").run(voice.id, new Date().toISOString(), new Date().toISOString()));
        db.close();
    });
});

describe("couple role autorizacija", () => {
    let server, adminCookie, coupleCookie;
    before(async () => {
        server = await startServer({ TEST_DISABLE_PROCESSING_WORKER: "1" });
        createCouple(server); adminCookie = await login(server); coupleCookie = await login(server, "test-couple");
    });
    after(async () => { await server?.stop(); });
    test("bez sesije je 401, admin je 403, couple je 200", async () => {
        assert.equal((await fetch(`${server.baseUrl}/api/couple/voice-messages`)).status, 401);
        assert.equal((await fetch(`${server.baseUrl}/api/couple/voice-messages`, { headers: { Cookie: adminCookie } })).status, 403);
        assert.equal((await fetch(`${server.baseUrl}/api/couple/voice-messages`, { headers: { Cookie: coupleCookie } })).status, 200);
    });
    test("/api/admin/me vraća id username role, a promena role važi odmah", async () => {
        const me = await fetch(`${server.baseUrl}/api/admin/me`, { headers: { Cookie: coupleCookie } });
        const body = await me.json();
        assert.deepEqual(Object.keys(body).sort(), ["id", "role", "username"]); assert.equal(body.role, "couple");
        const db = new Database(server.databasePath); db.prepare("UPDATE admins SET role = 'admin' WHERE username = 'test-couple'").run(); db.close();
        assert.equal((await fetch(`${server.baseUrl}/api/couple/voice-messages`, { headers: { Cookie: coupleCookie } })).status, 403);
    });
});

describe("voice worker i private couple API", () => {
    let server, cookie, voiceId;
    before(async () => {
        server = await startServer({ TEST_COUPLE_EMAIL: "fail" }); createCouple(server); cookie = await login(server, "test-couple");
        assert.equal((await upload(server, "VALID", "Ana")).status, 202);
        voiceId = await waitFor(() => {
            const db = new Database(server.databasePath, { readonly: true });
            const row = db.prepare("SELECT voice_messages.*, processing_jobs.status FROM voice_messages JOIN processing_jobs ON processing_jobs.target_id=voice_messages.id WHERE processing_jobs.target_type='voice_message'").get(); db.close();
            return row?.status === "completed" ? row.id : null;
        });
    });
    after(async () => { await server?.stop(); });
    test("normalizacija daje ready metadata i čisti incoming bez pravog emaila", () => {
        const db = new Database(server.databasePath, { readonly: true }); const row = db.prepare("SELECT * FROM voice_messages WHERE id=?").get(voiceId); db.close();
        assert.equal(row.mime_type, "audio/mp4"); assert.equal(row.duration_seconds, 3.25); assert.ok(row.size_bytes > 0); assert.equal(row.notification_sent_at, null);
        assert.equal(readdirSync(server.incoming).length, 0); assert.equal(existsSync(path.join(server.processed, row.filename)), true);
    });
    test("list i stats vraćaju privatni status bez filename-a", async () => {
        const list = await (await fetch(`${server.baseUrl}/api/couple/voice-messages`, { headers: { Cookie: cookie } })).json();
        assert.equal(list.messages[0].processingStatus, "ready"); assert.equal("filename" in list.messages[0], false);
        const stats = await (await fetch(`${server.baseUrl}/api/couple/voice-messages/stats`, { headers: { Cookie: cookie } })).json();
        assert.equal(stats.stats.total, 1); assert.equal(stats.stats.ready, 1); assert.equal(stats.stats.new, 1);
    });
    test("stream podržava 206 Range, download je attachment", async () => {
        const stream = await fetch(`${server.baseUrl}/api/couple/voice-messages/${voiceId}/stream`, { headers: { Cookie: cookie, Range: "bytes=0-3" } });
        assert.equal(stream.status, 206); assert.match(stream.headers.get("content-range"), /^bytes 0-3\//); assert.equal((await stream.arrayBuffer()).byteLength, 4);
        const download = await fetch(`${server.baseUrl}/api/couple/voice-messages/${voiceId}/download`, { headers: { Cookie: cookie } });
        assert.equal(download.status, 200); assert.match(download.headers.get("content-disposition"), /^attachment;/i);
    });
    test("listened true/false koristi server timestamp", async () => {
        const patch = (listened) => fetch(`${server.baseUrl}/api/couple/voice-messages/${voiceId}/listened`, { method: "PATCH", headers: { Cookie: cookie, Origin: "http://localhost", "Content-Type": "application/json" }, body: JSON.stringify({ listened }) });
        const listened = await (await patch(true)).json(); assert.ok(listened.listenedAt);
        const unlistened = await (await patch(false)).json(); assert.equal(unlistened.listenedAt, null);
    });
    test("ZIP zahteva couple i sadrži samo ready entry sa sanitizovanim imenom", async () => {
        assert.equal((await fetch(`${server.baseUrl}/api/couple/voice-messages/download`)).status, 401);
        const response = await fetch(`${server.baseUrl}/api/couple/voice-messages/download`, { headers: { Cookie: cookie } });
        assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "application/zip");
        const bytes = Buffer.from(await response.arrayBuffer()); assert.match(bytes.toString("latin1"), /_Ana_\d+\.m4a/);
    });
    test("delete ready uklanja DB, job i finalni fajl", async () => {
        const response = await fetch(`${server.baseUrl}/api/couple/voice-messages/${voiceId}`, { method: "DELETE", headers: { Cookie: cookie, Origin: "http://localhost" } });
        assert.equal(response.status, 200);
        const db = new Database(server.databasePath, { readonly: true }); assert.equal(db.prepare("SELECT COUNT(*) count FROM voice_messages").get().count, 0); assert.equal(db.prepare("SELECT COUNT(*) count FROM processing_jobs WHERE target_type='voice_message'").get().count, 0); db.close();
        assert.equal(readdirSync(server.processed).length, 0);
    });
});

describe("voice retry, restart recovery i delete concurrency", () => {
    test("FFmpeg failure koristi postojeći retry i max attempts postaje failed", async () => {
        const server = await startServer({ TEST_VOICE_PROCESSOR_FAILURE: "1", TEST_PROCESSING_RETRY_MS: "25,25,25" });
        try {
            assert.equal((await upload(server)).status, 202);
            const failed = await waitFor(() => { const db = new Database(server.databasePath, { readonly: true }); const row = db.prepare("SELECT * FROM processing_jobs WHERE target_type='voice_message'").get(); db.close(); return row?.status === "failed" ? row : null; });
            assert.equal(failed.attempt_count, 4);
            const db = new Database(server.databasePath, { readonly: true }); assert.equal(db.prepare("SELECT filename FROM voice_messages").get().filename, null); db.close();
        } finally { await server.stop(); }
    });
    test("stale processing posao se posle restarta oporavlja za voice", async () => {
        const first = await startServer({ TEST_VOICE_PROCESSOR_DELAY_MS: "5000", TEST_PROCESSING_STALE_MS: "1" });
        assert.equal((await upload(first)).status, 202);
        await waitFor(() => { const db = new Database(first.databasePath, { readonly: true }); const row = db.prepare("SELECT status FROM processing_jobs WHERE target_type='voice_message'").get(); db.close(); return row?.status === "processing"; });
        first.child.kill("SIGKILL"); await new Promise((resolve) => first.child.once("exit", resolve));
        const second = await startServer({ TEST_PROCESSING_STALE_MS: "1" }, first.dataRoot);
        try {
            await waitFor(() => { const db = new Database(second.databasePath, { readonly: true }); const row = db.prepare("SELECT status FROM processing_jobs WHERE target_type='voice_message'").get(); db.close(); return row?.status === "completed"; });
        } finally { await second.stop(); }
    });
    test("delete queued i delete tokom processing-a ne resurrectuju fajl", async () => {
        const queued = await startServer({ TEST_DISABLE_PROCESSING_WORKER: "1" }); createCouple(queued); const queuedCookie = await login(queued, "test-couple");
        assert.equal((await upload(queued)).status, 202);
        let db = new Database(queued.databasePath, { readonly: true }); const queuedId = db.prepare("SELECT id FROM voice_messages").get().id; db.close();
        assert.equal((await fetch(`${queued.baseUrl}/api/couple/voice-messages/${queuedId}`, { method: "DELETE", headers: { Cookie: queuedCookie, Origin: "http://localhost" } })).status, 200); assert.equal(readdirSync(queued.incoming).length, 0); await queued.stop();

        const active = await startServer({ TEST_VOICE_PROCESSOR_DELAY_MS: "300" }); createCouple(active); const activeCookie = await login(active, "test-couple");
        assert.equal((await upload(active)).status, 202);
        const activeId = await waitFor(() => { const check = new Database(active.databasePath, { readonly: true }); const row = check.prepare("SELECT target_id,status FROM processing_jobs WHERE target_type='voice_message'").get(); check.close(); return row?.status === "processing" ? row.target_id : null; });
        assert.equal((await fetch(`${active.baseUrl}/api/couple/voice-messages/${activeId}`, { method: "DELETE", headers: { Cookie: activeCookie, Origin: "http://localhost" } })).status, 200);
        await new Promise((resolve) => setTimeout(resolve, 500));
        db = new Database(active.databasePath, { readonly: true }); assert.equal(db.prepare("SELECT COUNT(*) count FROM voice_messages").get().count, 0); assert.equal(db.prepare("SELECT COUNT(*) count FROM processing_jobs WHERE target_type='voice_message'").get().count, 0); db.close(); assert.equal(readdirSync(active.processed).length, 0); await active.stop();
    });
});
