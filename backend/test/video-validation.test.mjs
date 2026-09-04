import assert from "node:assert/strict";
import { test } from "node:test";
import {
    MAX_VIDEO_FPS,
    MAX_VIDEO_STREAMS,
    VideoValidationError,
    parseVideoProbeJson,
    parseFrameRate,
    validateVideoProbe
} from "../dist/video-validation.js";

function probe(overrides = {}) {
    const video = {
        codec_type: "video",
        codec_name: "hevc",
        width: 1920,
        height: 1080,
        avg_frame_rate: "60/1",
        ...overrides.video
    };
    return {
        streams: overrides.streams ?? [video, { codec_type: "audio", codec_name: "aac" }],
        format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "12.5", ...overrides.format }
    };
}

function rejectsCode(input, code) {
    assert.throws(() => validateVideoProbe(input), (error) => {
        assert.ok(error instanceof VideoValidationError);
        assert.equal(error.code, code);
        return true;
    });
}

test("valid 1080p, 4K60, 8K portrait i video bez audio su prihvaćeni", () => {
    assert.equal(validateVideoProbe(probe()).width, 1920);
    assert.equal(validateVideoProbe(probe({ video: { width: 3840, height: 2160, avg_frame_rate: "60/1" } })).fps, 60);
    assert.equal(validateVideoProbe(probe({ video: { width: 4320, height: 8192, avg_frame_rate: "30/1" } })).height, 8192);
    assert.equal(validateVideoProbe(probe({ streams: [{ codec_type: "video", codec_name: "h264", width: 1280, height: 720, avg_frame_rate: "30/1" }] })).hasAudio, false);
});

test("framerate parser prihvata racionalne vrednosti i odbija zero/malformed", () => {
    assert.equal(parseFrameRate("60000/1001")?.toFixed(3), "59.940");
    assert.equal(parseFrameRate("240/1"), MAX_VIDEO_FPS);
    assert.equal(parseFrameRate("0/0"), null);
    assert.equal(parseFrameRate("bogus"), null);
});

test("container bez video streama i attachment/data stream se odbijaju", () => {
    rejectsCode(probe({ streams: [{ codec_type: "audio", codec_name: "aac" }] }), "INVALID_VIDEO");
    rejectsCode(probe({ streams: [probe().streams[0], { codec_type: "attachment" }] }), "UNSUPPORTED_VIDEO");
    rejectsCode(probe({ streams: [probe().streams[0], { codec_type: "data" }] }), "UNSUPPORTED_VIDEO");
});

test("zero/invalid duration, dimensions i fps se odbijaju", () => {
    rejectsCode(probe({ format: { duration: "0" } }), "VIDEO_METADATA_INVALID");
    rejectsCode(probe({ format: { duration: "NaN" } }), "VIDEO_METADATA_INVALID");
    rejectsCode(probe({ video: { width: 0 } }), "VIDEO_METADATA_INVALID");
    rejectsCode(probe({ video: { height: -1 } }), "VIDEO_METADATA_INVALID");
    rejectsCode(probe({ video: { avg_frame_rate: "0/0", r_frame_rate: "0/0" } }), "VIDEO_METADATA_INVALID");
});

test("resolution preko 8192x4320 i FPS preko 240 se odbijaju", () => {
    rejectsCode(probe({ video: { width: 8193, height: 4320 } }), "UNSUPPORTED_VIDEO");
    rejectsCode(probe({ video: { width: 4321, height: 8192 } }), "UNSUPPORTED_VIDEO");
    rejectsCode(probe({ video: { avg_frame_rate: "241/1" } }), "UNSUPPORTED_VIDEO");
});

test("više od osam streamova i malformed probe JSON shape se odbijaju", () => {
    const streams = Array.from({ length: MAX_VIDEO_STREAMS + 1 }, (_, index) => index === 0
        ? probe().streams[0]
        : { codec_type: "audio", codec_name: "aac" });
    rejectsCode(probe({ streams }), "UNSUPPORTED_VIDEO");
    rejectsCode(null, "INVALID_VIDEO");
    rejectsCode({ streams: [], format: {} }, "INVALID_VIDEO");
    assert.throws(() => parseVideoProbeJson("{not-json"), (error) => error.code === "INVALID_VIDEO");
});

test("codec nije uska allow-lista: HEVC i drugi imenovani codec-i ostaju dozvoljeni", () => {
    assert.equal(validateVideoProbe(probe({ video: { codec_name: "hevc" } })).codecName, "hevc");
    assert.equal(validateVideoProbe(probe({ video: { codec_name: "vp9" } })).codecName, "vp9");
    rejectsCode(probe({ video: { codec_name: "unknown" } }), "UNSUPPORTED_VIDEO");
});
