import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    IMAGE_UPLOAD_LIMIT,
    VIDEO_UPLOAD_LIMIT,
    imageDimensionViolation
} from "../dist/upload-safety.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("binary upload limiti i overflow-safe dimension policy", () => {
    assert.equal(IMAGE_UPLOAD_LIMIT, 30 * 1024 * 1024);
    assert.equal(VIDEO_UPLOAD_LIMIT, 1024 * 1024 * 1024);
    assert.equal(imageDimensionViolation(10_000, 10_000), null);
    assert.equal(imageDimensionViolation(10_001, 10_000), "pixels");
    assert.equal(imageDimensionViolation(16_384, 1), null);
    assert.equal(imageDimensionViolation(16_385, 1), "width");
    assert.equal(imageDimensionViolation(1, 16_385), "height");
    assert.equal(imageDimensionViolation(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), "width");
});

test("aktivni frontend razdvaja image/video endpoint uz progress i UX limite", async () => {
    const source = await readFile(path.join(projectRoot, "frontend/js/upload.js"), "utf8");
    assert.match(source, /30 \* 1024 \* 1024/);
    assert.match(source, /1024 \* 1024 \* 1024/);
    assert.match(source, /"\/api\/upload\/video"\s*:\s*"\/api\/upload\/image"/);
    assert.match(source, /xhr\.upload\.onprogress/);
    assert.match(source, /input\.multiple = true/);
    assert.doesNotMatch(source, /xhr\.open\("POST", "\/api\/upload"\)/);
    assert.match(source, /upload_image_too_large/);
    assert.match(source, /upload_video_too_large/);
});

test("translation katalog ima nove poruke i fallback jezike", async () => {
    const source = await readFile(path.join(projectRoot, "frontend/js/translations.js"), "utf8");
    assert.equal((source.match(/upload_image_too_large:/g) ?? []).length, 3);
    assert.equal((source.match(/upload_video_too_large:/g) ?? []).length, 3);
});
