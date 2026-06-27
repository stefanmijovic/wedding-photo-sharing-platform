import * as nsfwjs from "nsfwjs";
import * as tf from "@tensorflow/tfjs-node";
import fs from "fs";
import sharp from "sharp";

let model: nsfwjs.NSFWJS | null = null;

const PORN_REVIEW_THRESHOLD = 10;
const HENTAI_REVIEW_THRESHOLD = 5;
const SEXY_REVIEW_THRESHOLD = 85;

const BLUR_REVIEW_THRESHOLD = 50;
const MIN_IMAGE_WIDTH = 800;
const MIN_IMAGE_HEIGHT = 800;

async function getModel() {
    if (!model) {
        console.log("Učitavam AI moderation model...");
        model = await nsfwjs.load();
        console.log("AI moderation model učitan.");
    }

    return model;
}

async function getBlurScore(filePath: string) {
    const image = sharp(filePath)
        .greyscale()
        .resize({
            width: 300,
            withoutEnlargement: true
        });

    const { data, info } = await image
        .raw()
        .toBuffer({ resolveWithObject: true });

    const width = info.width;
    const height = info.height;

    if (width < 3 || height < 3) {
        return 0;
    }

    const values: number[] = [];

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const center = data[y * width + x] ?? 0;
            const top = data[(y - 1) * width + x] ?? 0;
            const bottom = data[(y + 1) * width + x] ?? 0;
            const left = data[y * width + (x - 1)] ?? 0;
            const right = data[y * width + (x + 1)] ?? 0;

            const laplacian = Math.abs(
                (4 * center) - top - bottom - left - right
            );

            values.push(laplacian);
        }
    }

    const mean =
        values.reduce((sum, value) => sum + value, 0) / values.length;

    const variance =
        values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;

    return Math.round(variance);
}

export async function moderateImage(filePath: string) {
    let imageTensor: tf.Tensor3D | null = null;

    try {
        const metadata = await sharp(filePath).metadata();

        const width = metadata.width ?? 0;
        const height = metadata.height ?? 0;

        if (width < MIN_IMAGE_WIDTH || height < MIN_IMAGE_HEIGHT) {
            return {
                status: "pending_review",
                aiScore: 0,
                aiReason: `Premala rezolucija: ${width}x${height}`
            };
        }

        const blurScore = await getBlurScore(filePath);

        if (blurScore < BLUR_REVIEW_THRESHOLD) {
            return {
                status: "pending_review",
                aiScore: blurScore,
                aiReason: `Mutna fotografija - blur score: ${blurScore}`
            };
        }

        const loadedModel = await getModel();

        const imageBuffer = fs.readFileSync(filePath);
        imageTensor = tf.node.decodeImage(imageBuffer, 3) as tf.Tensor3D;

        const predictions: any[] = await loadedModel.classify(imageTensor as any);

        const porn =
            Math.round((predictions.find((p: any) => p.className === "Porn")?.probability ?? 0) * 100);

        const hentai =
            Math.round((predictions.find((p: any) => p.className === "Hentai")?.probability ?? 0) * 100);

        const sexy =
            Math.round((predictions.find((p: any) => p.className === "Sexy")?.probability ?? 0) * 100);

        const reason = predictions
            .map((p: any) => `${p.className}: ${Math.round(p.probability * 100)}%`)
            .join(", ");

        if (
            porn >= PORN_REVIEW_THRESHOLD ||
            hentai >= HENTAI_REVIEW_THRESHOLD ||
            sexy >= SEXY_REVIEW_THRESHOLD
        ) {
            return {
                status: "pending_review",
                aiScore: Math.max(porn, hentai, sexy),
                aiReason: `AI review: ${reason}, blur score: ${blurScore}`
            };
        }

        return {
            status: "approved",
            aiScore: Math.max(porn, hentai, sexy),
            aiReason: `AI ok: ${reason}, blur score: ${blurScore}`
        };

    } catch (error) {
        console.error("AI moderation greška:", error);

        return {
            status: "pending_review",
            aiScore: 0,
            aiReason: "AI moderation failed - ručni pregled potreban"
        };

    } finally {
        if (imageTensor) {
            imageTensor.dispose();
        }
    }
}
