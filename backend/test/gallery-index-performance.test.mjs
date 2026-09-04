import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const INDEX_SQL = `
    CREATE INDEX IF NOT EXISTS idx_photos_status_uploaded
    ON photos(status, uploaded_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_photos_original_url ON photos(original_url);
    CREATE INDEX IF NOT EXISTS idx_photos_thumb_url ON photos(thumb_url);
    CREATE INDEX IF NOT EXISTS idx_photos_web_url ON photos(web_url);
`;

const GALLERY_SQL = `
    SELECT id, filename, original_url AS originalUrl, thumb_url AS thumbUrl,
           media_type AS mediaType, web_url AS webUrl, likes, uploaded_at AS uploadedAt
    FROM photos
    WHERE status = 'approved'
    ORDER BY uploaded_at DESC, id DESC
    LIMIT ? OFFSET ?
`;
const COUNT_SQL = "SELECT COUNT(*) AS count FROM photos WHERE status = 'approved'";
const URL_SQL = "SELECT status FROM photos WHERE original_url = ? OR thumb_url = ? OR web_url = ?";

function createSchema(db) {
    db.exec(`
        CREATE TABLE photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL UNIQUE,
            original_url TEXT NOT NULL,
            thumb_url TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'approved',
            uploaded_at TEXT NOT NULL,
            views INTEGER NOT NULL DEFAULT 0,
            downloads INTEGER NOT NULL DEFAULT 0,
            ai_score INTEGER NOT NULL DEFAULT 0,
            ai_reason TEXT NOT NULL DEFAULT '',
            media_type TEXT NOT NULL DEFAULT 'image',
            web_url TEXT NOT NULL DEFAULT '',
            likes INTEGER NOT NULL DEFAULT 0
        );
    `);
}

function seed(db, rows) {
    const insert = db.prepare(`
        INSERT INTO photos
            (filename, original_url, thumb_url, status, uploaded_at, media_type, web_url, likes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
        for (let i = 0; i < rows; i += 1) {
            const status = i % 10 < 7 ? "approved" : i % 2 ? "pending_review" : "hidden";
            const mediaType = i % 5 === 0 ? "video" : "image";
            const stamp = new Date(Date.UTC(2026, 9, 10, 10, Math.floor(i / 8), 0)).toISOString();
            insert.run(
                `media-${i}.dat`, `/uploads/original/media-${i}.dat`, `/uploads/thumbs/media-${i}.jpg`,
                status, stamp, mediaType, mediaType === "video" ? `/uploads/videos/web/media-${i}.mp4` : "", i % 17
            );
        }
    })();
}

function plan(db, sql, params = []) {
    return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => String(row.detail));
}

function page(db, pageNumber, limit) {
    const offset = (pageNumber - 1) * limit;
    const photos = db.prepare(GALLERY_SQL).all(limit, offset);
    const total = db.prepare(COUNT_SQL).get().count;
    return { photos, page: pageNumber, limit, total, hasMore: offset + photos.length < total };
}

test("before/after query plan uklanja gallery temp sort i koristi URL multi-index OR", () => {
    const db = new Database(":memory:");
    createSchema(db);
    seed(db, 1000);
    const beforeGallery = plan(db, GALLERY_SQL, [50, 0]);
    const beforeUrl = plan(db, URL_SQL, ["/missing", "/missing", "/missing"]);
    assert.ok(beforeGallery.some((detail) => detail.includes("SCAN photos")));
    assert.ok(beforeGallery.some((detail) => detail.includes("USE TEMP B-TREE FOR ORDER BY")));
    assert.ok(beforeUrl.some((detail) => detail.includes("SCAN photos")));

    db.exec(INDEX_SQL);
    const afterGallery = plan(db, GALLERY_SQL, [50, 0]);
    const afterCount = plan(db, COUNT_SQL);
    const afterUrl = plan(db, URL_SQL, ["/missing", "/missing", "/missing"]);
    assert.ok(afterGallery.some((detail) => detail.includes("idx_photos_status_uploaded")));
    assert.ok(!afterGallery.some((detail) => detail.includes("USE TEMP B-TREE")));
    assert.ok(afterCount.some((detail) => detail.includes("idx_photos_status_uploaded")));
    for (const index of ["idx_photos_original_url", "idx_photos_thumb_url", "idx_photos_web_url"]) {
        assert.ok(afterUrl.some((detail) => detail.includes(index)), `${index} nije u planu: ${afterUrl.join(" | ")}`);
    }
    db.close();
});
test("index initialization je idempotentna i ne menja user_version", () => {
    const db = new Database(":memory:");
    createSchema(db);
    const before = db.pragma("user_version", { simple: true });
    db.exec(INDEX_SQL);
    db.exec(INDEX_SQL);
    assert.equal(db.pragma("user_version", { simple: true }), before);
    assert.deepEqual(
        db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_photos_%' ORDER BY name").all().map((row) => row.name),
        ["idx_photos_original_url", "idx_photos_status_uploaded", "idx_photos_thumb_url", "idx_photos_web_url"]
    );
    db.close();
});

test("isti uploaded_at je determinističan kroz tri stranice bez duplikata/preskakanja", () => {
    const db = new Database(":memory:");
    createSchema(db);
    const insert = db.prepare(`INSERT INTO photos
        (filename,original_url,thumb_url,status,uploaded_at,media_type,web_url,likes)
        VALUES (?,?,?,'approved',?,'image','',0)`);
    const tiedAt = "2026-10-10T10:10:10.000Z";
    db.transaction(() => {
        for (let i = 0; i < 27; i += 1) insert.run(`tie-${i}.jpg`, `/o/${i}`, `/t/${i}`, tiedAt);
    })();
    db.exec(INDEX_SQL);
    const pages = [page(db, 1, 10), page(db, 2, 10), page(db, 3, 10)];
    const ids = pages.flatMap((result) => result.photos.map((photo) => photo.id));
    assert.deepEqual(ids, Array.from({ length: 27 }, (_, index) => 27 - index));
    assert.equal(new Set(ids).size, 27);
    assert.deepEqual(pages.map((result) => result.hasMore), [true, true, false]);
    db.close();
});

test("pagination contract, boundaries i status filter ostaju kompatibilni", () => {
    const db = new Database(":memory:");
    createSchema(db);
    seed(db, 200);
    db.exec(INDEX_SQL);
    const total = db.prepare(COUNT_SQL).get().count;
    assert.equal(total, 140);
    const first = page(db, 1, 50);
    const second = page(db, 2, 50);
    const last = page(db, 3, 50);
    const beyond = page(db, 4, 50);
    assert.deepEqual(Object.keys(first), ["photos", "page", "limit", "total", "hasMore"]);
    assert.deepEqual([first.photos.length, second.photos.length, last.photos.length, beyond.photos.length], [50, 50, 40, 0]);
    assert.deepEqual([first.hasMore, second.hasMore, last.hasMore, beyond.hasMore], [true, true, false, false]);
    assert.ok([first, second, last].flatMap((result) => result.photos).every((photo) => photo.mediaType === "image" || photo.mediaType === "video"));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM photos WHERE status <> 'approved'").get().count, 60);
    db.close();
});

test("original/thumb/web URL lookup, unknown, empty video URL i duplicate URL ostaju podržani", () => {
    const db = new Database(":memory:");
    createSchema(db);
    seed(db, 50);
    db.exec(INDEX_SQL);
    for (const url of ["/uploads/original/media-1.dat", "/uploads/thumbs/media-2.jpg", "/uploads/videos/web/media-5.mp4"]) {
        assert.ok(db.prepare(URL_SQL).get(url, url, url));
    }
    assert.equal(db.prepare(URL_SQL).get("/unknown", "/unknown", "/unknown"), undefined);
    assert.ok(db.prepare(URL_SQL).get("", "", ""));
    db.prepare(`INSERT INTO photos
        (filename,original_url,thumb_url,status,uploaded_at,media_type,web_url,likes)
        VALUES ('duplicate.jpg','/uploads/original/media-1.dat','/duplicate-thumb','approved',?,'image','',0)`)
        .run(new Date().toISOString());
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM photos WHERE original_url=?").get("/uploads/original/media-1.dat").count, 2);
    assert.throws(() => db.prepare(`INSERT INTO photos
        (filename,original_url,thumb_url,status,uploaded_at,media_type,web_url,likes)
        VALUES ('null.jpg',NULL,'/null','approved',?,'image','',0)`).run(new Date().toISOString()), /NOT NULL/);
    db.close();
});

test("50/200/500/1000 fixture datasets vraćaju tačan approved total", () => {
    for (const rows of [50, 200, 500, 1000]) {
        const db = new Database(":memory:");
        createSchema(db);
        seed(db, rows);
        db.exec(INDEX_SQL);
        assert.equal(page(db, 1, 50).total, rows * 0.7);
        db.close();
    }
});
