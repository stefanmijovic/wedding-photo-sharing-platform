import express from "express";
import cors from "cors";
import multer from "multer";
import rateLimit from "express-rate-limit";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import sharp from "sharp";
import Database from "better-sqlite3";
import { execFile } from "child_process";
import { moderateImage } from "./moderation.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const archiver = require("archiver");
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.disable("x-powered-by");

const PORT = Number(process.env.PORT) || 3000;

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
const ADMIN_PANEL_URL = process.env.ADMIN_PANEL_URL || "/admin.html";

function sendPendingReviewEmail(photoId: number, filename: string) {
    const subject = "Wedding app: fotografija čeka pregled";

    const body = `
Nova fotografija je poslata na pregled.

ID: ${photoId}
Fajl: ${filename}

Admin panel:
${ADMIN_PANEL_URL}

Ovo je automatska poruka.
`;

    const mailProcess = execFile(
        "mail",
        ["-s", subject, ADMIN_EMAIL],
        (error) => {
            if (error) {
                console.error("Greška pri slanju email notifikacije:", error);
                return;
            }

            console.log("Email notifikacija poslata za pending_review:", photoId);
        }
    );

    mailProcess.stdin?.write(body);
    mailProcess.stdin?.end();
}

app.set("trust proxy", 1);

app.use(cors({
    origin: [
        "https://ivaniandrijana.cloud",
        "https://www.ivaniandrijana.cloud",
        "http://localhost",
        "http://localhost:3000"
    ],
    methods: ["GET", "POST", "PATCH", "DELETE"],
    credentials: false
}));

app.use(express.json());

const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: {
        error: "Previše zahteva. Pokušajte ponovo kasnije."
    }
});

const uploadFolderOriginal = path.join(__dirname, "../../uploads/original");
const uploadFolderThumbs = path.join(__dirname, "../../uploads/thumbs");
const uploadFolderVideosOriginal = path.join(__dirname, "../../uploads/videos/original");
const uploadFolderVideosThumbs = path.join(__dirname, "../../uploads/videos/thumbs");
const uploadFolderVideosWeb = path.join(__dirname, "../../uploads/videos/web");
const dbPath = path.join(__dirname, "../../database.sqlite");

if (!fs.existsSync(uploadFolderOriginal)) {
    fs.mkdirSync(uploadFolderOriginal, { recursive: true });
}

if (!fs.existsSync(uploadFolderThumbs)) {
    fs.mkdirSync(uploadFolderThumbs, { recursive: true });
}

if (!fs.existsSync(uploadFolderVideosWeb)) {
    fs.mkdirSync(uploadFolderVideosWeb, { recursive: true });
}

if (!fs.existsSync(uploadFolderVideosOriginal)) {
    fs.mkdirSync(uploadFolderVideosOriginal, { recursive: true });
}

if (!fs.existsSync(uploadFolderVideosThumbs)) {
    fs.mkdirSync(uploadFolderVideosThumbs, { recursive: true });
}

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");

db.exec(`
    CREATE TABLE IF NOT EXISTS photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL UNIQUE,
        original_url TEXT NOT NULL,
        thumb_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'approved',
        uploaded_at TEXT NOT NULL,
        views INTEGER NOT NULL DEFAULT 0,
        downloads INTEGER NOT NULL DEFAULT 0
    );
`);

const existingColumns = db.prepare(`PRAGMA table_info(photos)`).all() as { name: string }[];

const hasAiScore = existingColumns.some(col => col.name === "ai_score");
const hasAiReason = existingColumns.some(col => col.name === "ai_reason");

if (!hasAiScore) {
    db.exec(`ALTER TABLE photos ADD COLUMN ai_score INTEGER NOT NULL DEFAULT 0`);
}

if (!hasAiReason) {
    db.exec(`ALTER TABLE photos ADD COLUMN ai_reason TEXT NOT NULL DEFAULT ''`);
}

const hasMediaType = existingColumns.some(
    col => col.name === "media_type"
);

if (!hasMediaType) {
    db.exec(`
        ALTER TABLE photos
        ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image'
    `);
}

const hasWebUrl = existingColumns.some(
    col => col.name === "web_url"
);

if (!hasWebUrl) {
    db.exec(`
        ALTER TABLE photos
        ADD COLUMN web_url TEXT NOT NULL DEFAULT ''
    `);

    console.log("Dodata kolona web_url");
}

const hasLikes = existingColumns.some(
    col => col.name === "likes"
);

if (!hasLikes) {
    db.exec(`
        ALTER TABLE photos
        ADD COLUMN likes INTEGER NOT NULL DEFAULT 0
    `);

    console.log("Dodata kolona likes");
}

db.exec(`
    CREATE TABLE IF NOT EXISTS photo_likes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        photo_id INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(photo_id, client_id)
    );
`);

app.use("/uploads", express.static(path.join(__dirname, "../../uploads")));

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.mimetype.startsWith("video/")) {
            cb(null, uploadFolderVideosOriginal);
            return;
        }

        cb(null, uploadFolderOriginal);
    },
    filename: (req, file, cb) => {
        const uniqueName =
            Date.now() +
            "-" +
            Math.round(Math.random() * 1e9) +
            path.extname(file.originalname).toLowerCase();

        cb(null, uniqueName);
    }
});

const fileFilter = (req: any, file: Express.Multer.File, cb: Function) => {
    if (
        file.mimetype.startsWith("image/") ||
        file.mimetype.startsWith("video/")
    ) {
        cb(null, true);
    } else {
        cb(
            new Error("Dozvoljene su samo slike i video fajlovi"),
            false
        );
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 500 * 1024 * 1024
    }
});

let aiJobCounter = 0;
let aiQueue = Promise.resolve();

function runAiModerationQueued(filePath: string) {
    const jobId = ++aiJobCounter;

    console.log("AI queue čeka:", jobId, path.basename(filePath));

    const job = aiQueue.then(async () => {
        console.log("AI queue počinje:", jobId, path.basename(filePath));

        const result = await moderateImage(filePath);

        console.log(
            "AI queue završena:",
            jobId,
            path.basename(filePath),
            result.status,
            result.aiScore
        );

        return result;
    });

    aiQueue = job
        .then(() => undefined)
        .catch(() => undefined);

    return job;
}

let videoQueue = Promise.resolve();

function enqueueVideoJob(job: () => Promise<void>) {
    videoQueue = videoQueue
        .then(job)
        .catch((error) => {
            console.error("Video queue greška:", error);
        });

    return videoQueue;
}

function runNiceFfmpeg(args: string[]) {
    return new Promise<void>((resolve, reject) => {
        execFile(
            "nice",
            ["-n", "10", "ffmpeg", ...args],
            (error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            }
        );
    });
}

let videoJobCounter = 0;

function processVideoInBackground(
    photoId: number,
    filePath: string,
    filename: string
) {
    const jobId = ++videoJobCounter;

    console.log(
        "VIDEO QUEUE ČEKA:",
        jobId,
        photoId,
        filename
    );

    enqueueVideoJob(async () => {

        console.log(
            "VIDEO QUEUE POČINJE:",
            jobId,
            photoId,
            filename
        );

        await processVideoJob(
            photoId,
            filePath,
            filename
        );

        console.log(
            "VIDEO QUEUE ZAVRŠENA:",
            jobId,
            photoId,
            filename
        );
    });
}

async function processVideoJob(
    photoId: number,
    filePath: string,
    filename: string
) {
    const videoThumbName = filename + ".jpg";
    const videoThumbPath = path.join(
        uploadFolderVideosThumbs,
        videoThumbName
    );

    const webVideoName = filename;
    const webVideoPath = path.join(
        uploadFolderVideosWeb,
        webVideoName
    );

    const thumbUrl = `/uploads/videos/thumbs/${videoThumbName}`;
    const webUrl = `/uploads/videos/web/${webVideoName}`;

    console.log("Pokrećem queued video obradu:", photoId, filename);

    await runNiceFfmpeg([
        "-y",
        "-i", filePath,
        "-ss", "00:00:01",
        "-vframes", "1",
        "-vf", "scale=400:400:force_original_aspect_ratio=increase,crop=400:400",
        videoThumbPath
    ]);

    await runNiceFfmpeg([
        "-y",
        "-i", filePath,
        "-vf", "scale='min(1280,iw)':-2",
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "28",
        "-movflags", "+faststart",
        "-c:a", "aac",
        "-b:a", "128k",
        "-threads", "2",
        webVideoPath
    ]);

    db.prepare(`
        UPDATE photos
        SET
            thumb_url = ?,
            web_url = ?,
            ai_reason = ?
        WHERE id = ?
    `).run(
        thumbUrl,
        webUrl,
        "Video fajl - web verzija spremna, ručni pregled potreban",
        photoId
    );

    console.log("Queued video obrada završena:", photoId);
}

app.post("/api/upload", uploadLimiter, upload.single("photo"), async (req, res) => {
    const file = req.file;

    if (!file) {
        return res.status(400).json({
            error: "Nijedan fajl nije poslat."
        });
    }

    const isVideo = file.mimetype.startsWith("video/");
    const mediaType = isVideo ? "video" : "image";

    console.log("Fajl primljen:", file.filename, mediaType);

    try {
        let originalUrl = "";
        let thumbUrl = "";
        let webUrl = "";
        let status = "approved";
        let aiScore = 0;
        let aiReason = "";

        if (isVideo) {
            originalUrl = `/uploads/videos/original/${file.filename}`;
            thumbUrl = "";
            webUrl = "";

            status = "pending_review";
            aiScore = 0;
            aiReason = "Video fajl - obrada u toku, ručni pregled potreban";

        } else {
            const thumbPath = path.join(uploadFolderThumbs, file.filename);

            await sharp(file.path)
                .rotate()
                .jpeg({ quality: 95 })
                .toFile(file.path + ".fixed");

            fs.renameSync(file.path + ".fixed", file.path);

            await sharp(file.path)
                .resize({
                    width: 400,
                    height: 400,
                    fit: "cover"
                })
                .jpeg({ quality: 80 })
                .toFile(thumbPath);

            originalUrl = `/uploads/original/${file.filename}`;
            thumbUrl = `/uploads/thumbs/${file.filename}`;

	    const moderation = await runAiModerationQueued(file.path);	    

            status = moderation.status;
            aiScore = moderation.aiScore;
            aiReason = moderation.aiReason;
        }

        const insertResult = db.prepare(`
            INSERT INTO photos (
                filename,
                original_url,
                thumb_url,
                status,
                uploaded_at,
                ai_score,
                ai_reason,
                media_type,
                web_url
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            file.filename,
            originalUrl,
            thumbUrl,
            status,
            new Date().toISOString(),
            aiScore,
            aiReason,
            mediaType,
            webUrl
        );

        const insertedId = Number(insertResult.lastInsertRowid);

        if (status === "pending_review") {
            sendPendingReviewEmail(insertedId, file.filename);
        }

        if (isVideo) {
            processVideoInBackground(
                insertedId,
                file.path,
                file.filename
            );
        }

        res.json({
            message: isVideo
                ? "Video je uploadovan i obrada je pokrenuta u pozadini."
                : "Slika i thumbnail uspešno uploadovani!",
            filename: file.filename,
            mediaType,
            originalUrl,
            thumbUrl,
            webUrl,
            status
        });

    } catch (error) {
        console.error("Greška pri obradi fajla:", error);

        try {
            fs.unlinkSync(file.path);
        } catch {}

        res.status(500).json({
            error: "Greška pri obradi fajla."
        });
    }
});

app.get("/api/photos", (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const offset = (page - 1) * limit;

    const photos = db.prepare(`
	SELECT
    id,
    filename,
    original_url AS originalUrl,
    thumb_url AS thumbUrl,
    media_type AS mediaType,
    web_url AS webUrl,
    likes,
    uploaded_at AS uploadedAt
        FROM photos
        WHERE status = 'approved'
        ORDER BY uploaded_at DESC
        LIMIT ?
        OFFSET ?
    `).all(limit, offset);

    const total = db.prepare(`
        SELECT COUNT(*) AS count
        FROM photos
        WHERE status = 'approved'
    `).get() as { count: number };

    res.json({
        photos,
        page,
        limit,
        total: total.count,
        hasMore: offset + photos.length < total.count
    });
});

app.get("/api/photos/:id/download", (req, res) => {
    const id = Number(req.params.id);

    const photo = db.prepare(`
 SELECT
        id,
        filename,
        media_type AS mediaType
    FROM photos
    WHERE id = ?
    AND status = 'approved'
`).get(id) as {
    id: number;
    filename: string;
    mediaType: string;
} | undefined;

    if (!photo) {
        return res.status(404).json({
            error: "Slika nije pronađena."
        });
    }

const filePath = path.join(
    photo.mediaType === "video"
        ? uploadFolderVideosOriginal
        : uploadFolderOriginal,
    photo.filename
);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({
            error: "Fajl ne postoji."
        });
    }

    db.prepare(`
        UPDATE photos
        SET downloads = downloads + 1
        WHERE id = ?
    `).run(id);

    return res.download(
        filePath,
        photo.filename
    );
});

app.post("/api/photos/:id/like", (req, res) => {
    const id = Number(req.params.id);
    const clientId = String(req.body.clientId || "").trim();

    if (!clientId) {
        return res.status(400).json({
            error: "clientId je obavezan."
        });
    }

    const photo = db.prepare(`
        SELECT id, likes
        FROM photos
        WHERE id = ?
        AND status = 'approved'
    `).get(id) as { id: number; likes: number } | undefined;

    if (!photo) {
        return res.status(404).json({
            error: "Fajl nije pronađen."
        });
    }

    try {
        db.prepare(`
            INSERT INTO photo_likes (
                photo_id,
                client_id,
                created_at
            ) VALUES (?, ?, ?)
        `).run(
            id,
            clientId,
            new Date().toISOString()
        );

        db.prepare(`
            UPDATE photos
            SET likes = likes + 1
            WHERE id = ?
        `).run(id);

    } catch (error) {
        // Ako već postoji lajk za ovaj clientId i photo_id,
        // ne radimo ništa. Jedan uređaj = jedan lajk.
    }

    const updated = db.prepare(`
        SELECT likes
        FROM photos
        WHERE id = ?
    `).get(id) as { likes: number };

    res.json({
        id,
        likes: updated.likes,
        liked: true
    });
});

app.get("/api/admin/photos", (req, res) => {
    const photos = db.prepare(`
        SELECT
            id,
            filename,
            original_url AS originalUrl,
            thumb_url AS thumbUrl,
            status,
            uploaded_at AS uploadedAt,
            views,
            downloads,
            likes,
            ai_score AS aiScore,
            ai_reason AS aiReason,
	    media_type AS mediaType,
	    web_url AS webUrl
        FROM photos
        ORDER BY
            CASE
                WHEN status = 'pending_review' THEN 0
                WHEN status = 'approved' THEN 1
                WHEN status = 'hidden' THEN 2
                ELSE 3
            END,
            uploaded_at DESC
    `).all();

    res.json({ photos });
});
    

app.get("/api/admin/stats", (req, res) => {
    const stats = db.prepare(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
            SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'hidden' THEN 1 ELSE 0 END) AS hidden,
            COALESCE(SUM(downloads), 0) AS downloads
        FROM photos
    `).get();

    res.json({ stats });
});

app.patch("/api/admin/photos/:id/hide", (req, res) => {
    const id = Number(req.params.id);

    const result = db.prepare(`
        UPDATE photos
        SET status = 'hidden'
        WHERE id = ?
    `).run(id);

    if (result.changes === 0) {
        return res.status(404).json({
            error: "Slika nije pronađena."
        });
    }

    res.json({
        message: "Slika je sakrivena.",
        id,
        status: "hidden"
    });
});

app.patch("/api/admin/photos/:id/pending", (req, res) => {
    const id = Number(req.params.id);

    const photo = db.prepare(`
        SELECT
            id,
            filename,
            status
        FROM photos
        WHERE id = ?
    `).get(id) as { id: number; filename: string; status: string } | undefined;

    if (!photo) {
        return res.status(404).json({
            error: "Slika nije pronađena."
        });
    }

    const result = db.prepare(`
        UPDATE photos
        SET status = 'pending_review'
        WHERE id = ?
    `).run(id);

    if (result.changes === 0) {
        return res.status(404).json({
            error: "Slika nije pronađena."
        });
    }

    if (photo.status !== "pending_review") {
        sendPendingReviewEmail(photo.id, photo.filename);
    }

    res.json({
        message: "Slika je poslata na pregled.",
        id,
        status: "pending_review"
    });
});

app.patch("/api/admin/photos/:id/approve", (req, res) => {
    const id = Number(req.params.id);

    const result = db.prepare(`
        UPDATE photos
        SET status = 'approved'
        WHERE id = ?
    `).run(id);

    if (result.changes === 0) {
        return res.status(404).json({
            error: "Slika nije pronađena."
        });
    }

    res.json({
        message: "Slika je odobrena.",
        id,
        status: "approved"
    });
});

app.delete("/api/admin/photos/:id", (req, res) => {
    const id = Number(req.params.id);

const photo = db.prepare(`
    SELECT
        id,
        filename,
        media_type AS mediaType
    FROM photos
    WHERE id = ?
`).get(id) as {
    id: number;
    filename: string;
    mediaType: string;
} | undefined;

    if (!photo) {
        return res.status(404).json({
            error: "Slika nije pronađena."
        });
    }

const originalPath = path.join(
    photo.mediaType === "video"
        ? uploadFolderVideosOriginal
        : uploadFolderOriginal,
    photo.filename
);

const thumbPath = path.join(
    photo.mediaType === "video"
        ? uploadFolderVideosThumbs
        : uploadFolderThumbs,
    photo.mediaType === "video"
        ? photo.filename + ".jpg"
        : photo.filename
);

    try {
        if (fs.existsSync(originalPath)) {
            fs.unlinkSync(originalPath);
        }

        if (fs.existsSync(thumbPath)) {
            fs.unlinkSync(thumbPath);
        }

        db.prepare(`
            DELETE FROM photos
            WHERE id = ?
        `).run(id);

        res.json({
            message: "Slika je obrisana.",
            id
        });
    } catch (error) {
        console.error("Greška pri brisanju slike:", error);

        res.status(500).json({
            error: "Greška pri brisanju slike."
        });
    }
});

app.get("/api/admin/download/photos", (req, res) => {
    const photos = db.prepare(`
        SELECT filename
        FROM photos
        WHERE status = 'approved'
        AND media_type = 'image'
    `).all() as { filename: string }[];

    res.setHeader(
        "Content-Disposition",
        `attachment; filename="wedding-photos.zip"`
    );

    res.setHeader("Content-Type", "application/zip");

const archive = new archiver.ZipArchive({
    zlib: { level: 9 }
});

    archive.pipe(res);

    photos.forEach(photo => {
        const filePath = path.join(uploadFolderOriginal, photo.filename);

        if (fs.existsSync(filePath)) {
            archive.file(filePath, { name: photo.filename });
        }
    });

    archive.finalize();
});

app.get("/api/admin/download/videos", (req, res) => {
    const videos = db.prepare(`
        SELECT filename
        FROM photos
        WHERE status = 'approved'
        AND media_type = 'video'
    `).all() as { filename: string }[];

    res.setHeader(
        "Content-Disposition",
        `attachment; filename="wedding-videos.zip"`
    );

    res.setHeader("Content-Type", "application/zip");

const archive = new archiver.ZipArchive({
    zlib: { level: 9 }
});

    archive.pipe(res);

    videos.forEach(video => {
        const filePath = path.join(uploadFolderVideosOriginal, video.filename);

        if (fs.existsSync(filePath)) {
            archive.file(filePath, { name: video.filename });
        }
    });

    archive.finalize();
});

app.get("/api/health", (req, res) => {
    res.json({
        status: "ok",
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("ERROR:", err);

    res.status(500).json({
        error: "Internal server error"
    });
});

const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server radi na portu ${PORT}`);
});

server.on("error", (error) => {
    console.error("SERVER ERROR:", error);
});

process.on("SIGTERM", () => {
    console.log("SIGTERM primljen");
    server.close(() => {
        db.close();
        process.exit(0);
    });
});

process.on("SIGINT", () => {
    console.log("SIGINT primljen");
    server.close(() => {
        db.close();
        process.exit(0);
    });
});
