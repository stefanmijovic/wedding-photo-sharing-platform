export const IMAGE_UPLOAD_LIMIT = 30 * 1024 * 1024;
export const VIDEO_UPLOAD_LIMIT = 1024 * 1024 * 1024;
export const MAX_IMAGE_WIDTH = 16_384;
export const MAX_IMAGE_HEIGHT = 16_384;
export const MAX_IMAGE_PIXELS = 100_000_000;

export type ImageDimensionViolation = "width" | "height" | "pixels" | null;

export function imageDimensionViolation(width: number, height: number): ImageDimensionViolation {
    if (!Number.isSafeInteger(width) || width <= 0) return "width";
    if (!Number.isSafeInteger(height) || height <= 0) return "height";
    if (width > MAX_IMAGE_WIDTH) return "width";
    if (height > MAX_IMAGE_HEIGHT) return "height";
    // Division avoids multiplication overflow and keeps the 100 MP boundary inclusive.
    if (width > Math.floor(MAX_IMAGE_PIXELS / height)) return "pixels";
    return null;
}
