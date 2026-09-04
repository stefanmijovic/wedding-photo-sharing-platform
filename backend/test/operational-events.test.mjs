import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OperationalRejectionLogger } from "../dist/operational-events.js";

describe("Phase 3C structured operational rejection logging", () => {
    test("emits only fixed aggregate fields", () => {
        const lines = [];
        const logger = new OperationalRejectionLogger({ warn: (line) => lines.push(line) }, 60_000, () => 1_000);
        logger.record("CAPACITY_REJECTION", "video", "VIDEO_QUEUE_BUSY");
        assert.deepEqual(lines, ["[CAPACITY_REJECTION] category=video code=VIDEO_QUEUE_BUSY suppressed=0"]);
        assert.doesNotMatch(lines[0], /cookie|session|token|filename|path|body|sql|password|secret|@|\//i);
    });

    test("rate limits identical keys and reports the suppressed count in the next window", () => {
        let now = 1_000;
        const lines = [];
        const logger = new OperationalRejectionLogger({ warn: (line) => lines.push(line) }, 60_000, () => now);
        logger.record("CAPACITY_REJECTION", "image", "IMAGE_PIPELINE_BUSY");
        logger.record("CAPACITY_REJECTION", "image", "IMAGE_PIPELINE_BUSY");
        logger.record("CAPACITY_REJECTION", "image", "IMAGE_PIPELINE_BUSY");
        assert.equal(lines.length, 1);
        now += 60_001;
        logger.record("CAPACITY_REJECTION", "image", "IMAGE_PIPELINE_BUSY");
        assert.equal(lines.length, 2);
        assert.equal(lines[1], "[CAPACITY_REJECTION] category=image code=IMAGE_PIPELINE_BUSY suppressed=2");
    });

    test("different stable keys have independent windows", () => {
        const lines = [];
        const logger = new OperationalRejectionLogger({ warn: (line) => lines.push(line) }, 60_000, () => 1_000);
        logger.record("CAPACITY_REJECTION", "video", "VIDEO_QUEUE_BUSY");
        logger.record("DB_CONTENTION_REJECTION", "api", "DB_TEMPORARILY_BUSY");
        assert.equal(lines.length, 2);
    });

    test("malformed runtime values fail closed to allow-listed aggregates", () => {
        const lines = [];
        const logger = new OperationalRejectionLogger({ warn: (line) => lines.push(line) }, 60_000, () => 1_000);
        logger.record("CAPACITY_REJECTION", "video filename=/private/name.mp4", "TOKEN=secret");
        assert.equal(lines[0], "[CAPACITY_REJECTION] category=api code=CAPACITY_TEMPORARILY_UNAVAILABLE suppressed=0");
        assert.doesNotMatch(lines[0], /private|name\.mp4|secret|token/i);
    });
});
