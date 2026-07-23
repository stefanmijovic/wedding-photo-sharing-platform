// ============================================================
// UČITAVANJE .ENV FAJLA - MORA biti pre svih ostalih importa/koda
// ============================================================
// dotenv čita .env fajl iz root-a projekta i ubacuje vrednosti u process.env.
// Ovo mora ići na samom vrhu fajla, pre nego što se process.env bilo gde koristi,
// jer sve ostale konstante (npr. ADMIN_EMAIL) čitaju process.env odmah pri importu.
import dotenv from "dotenv";

dotenv.config();

// ============================================================
// IMPORTI - eksterne biblioteke i moduli koji se koriste u aplikaciji
// ============================================================
import express from "express";              // Web framework za kreiranje HTTP servera i ruta
import cors from "cors";                     // Middleware za kontrolu Cross-Origin zahteva (CORS)
import multer from "multer";                 // Middleware za upload fajlova (multipart/form-data)
import rateLimit from "express-rate-limit";  // Middleware za ograničavanje broja zahteva (anti-spam/anti-brute-force)
import path from "path";                     // Node.js modul za rad sa putanjama fajlova
import fs from "fs";                         // Node.js modul za rad sa fajl sistemom
import { fileURLToPath } from "url";         // Pomoćna funkcija za dobijanje putanje fajla iz ESM import.meta.url
import sharp from "sharp";                   // Biblioteka za obradu i konverziju slika (resize, rotate, kompresija)
import Database from "better-sqlite3";       // Sinhrona SQLite biblioteka za rad sa bazom podataka
import { execFile } from "child_process";    // Node.js modul za pokretanje eksternih programa (mail, ffmpeg)
import { moderateImage } from "./moderation.js"; // Lokalni modul - AI moderacija slika (detekcija neprikladnog sadržaja)
import { createRequire } from "module";      // Omogućava korišćenje CommonJS require() unutar ESM modula
import bcrypt from "bcrypt";                 // Biblioteka za heširanje i proveru lozinki
import session from "express-session";       // Middleware za upravljanje sesijama (login admin panela)

// ============================================================
// TYPESCRIPT DEKLARACIJA - proširenje tipa sesije
// ============================================================
// Dodaje custom polja (adminId, username) u SessionData tip
// da bi TypeScript znao da ova polja postoje u req.session
declare module "express-session" {
    interface SessionData {
        adminId?: number;
        username?: string;
    }
}

// ============================================================
// SETUP ZA CommonJS BIBLIOTEKE U ESM OKRUŽENJU
// ============================================================
const require = createRequire(import.meta.url); // Kreira require() funkciju za CommonJS pakete (archiver nema dobru ESM podršku)
const archiver = require("archiver");            // Biblioteka za kreiranje ZIP arhiva (download svih slika/videa odjednom)
const __filename = fileURLToPath(import.meta.url); // Putanja trenutnog fajla (ESM ekvivalent CommonJS __filename)
const __dirname = path.dirname(__filename);        // Direktorijum trenutnog fajla (ESM ekvivalent CommonJS __dirname)

// ============================================================
// INICIJALIZACIJA EXPRESS APLIKACIJE
// ============================================================
const app = express();

app.disable("x-powered-by"); // Bezbednosna mera - ne otkriva se da je backend napisan u Express-u

const PORT = Number(process.env.PORT) || 3000; // Port servera - iz env varijable ili default 3000

/**
 * Pomoćna funkcija koja čita obaveznu environment varijablu.
 * Ako varijabla nije definisana u .env fajlu, baca grešku i
 * server odbija da se pokrene - bolje da padne odmah na startu
 * nego da radi sa praznim/pogrešnim vrednostima (npr. bez admin emaila).
 */
function getRequiredEnv(name: string): string {
    const value = process.env[name];

    if (!value) {
        throw new Error(`${name} mora biti definisan u .env fajlu.`);
    }

    return value;
}

// ============================================================
// KONFIGURACIJA ZA ADMIN EMAIL NOTIFIKACIJE
// ============================================================
// Ove vrednosti se sada čitaju iz .env fajla umesto da su hardkodovane u kodu
const ADMIN_EMAIL = getRequiredEnv("ADMIN_EMAIL");           // Email adresa administratora koji dobija notifikacije
const ADMIN_PANEL_URL = getRequiredEnv("ADMIN_PANEL_URL");   // Link ka admin panelu koji se šalje u emailu
const SESSION_SECRET = getRequiredEnv("SESSION_SECRET");

if (SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET mora imati najmanje 32 karaktera.");
}

/**
 * Funkcija koja šalje email notifikaciju administratoru kada
 * neka fotografija/video zahteva ručni pregled (pending_review).
 * Koristi lokalni "mail" komandni program (execFile) umesto
 * SMTP biblioteke - vrv se oslanja na sistemski mail transfer agent.
 */
function sendPendingReviewEmail(photoId: number, filename: string) {
    const subject = "Wedding app: fotografija čeka pregled";

    // Sadržaj email poruke sa ID-jem fajla, imenom i linkom ka admin panelu
    const body = `
Nova fotografija je poslata na pregled.

ID: ${photoId}
Fajl: ${filename}

Admin panel:
${ADMIN_PANEL_URL}

Ovo je automatska poruka.
`;

    // Pokreće se sistemska "mail" komanda sa subjektom i primaocem kao argumentima
    const mailProcess = execFile("mail", ["-s", subject, ADMIN_EMAIL], (error) => {
        if (error) {
            console.error("Greška pri slanju email notifikacije:", error);
            return;
        }

        console.log("Email notifikacija poslata za pending_review:", photoId);
    });

    // Telo emaila se piše direktno u standard input procesa "mail"
    mailProcess.stdin?.write(body);
    mailProcess.stdin?.end();
}

// Kaže Express-u da veruje proxy serveru ispred aplikacije (npr. nginx)
// Bitno za ispravno čitanje IP adresa i "secure" cookie-ja iza reverse proxy-ja
app.set("trust proxy", 1);

// ============================================================
// CORS KONFIGURACIJA
// ============================================================
// Definiše koji frontend domeni smeju da pristupaju ovom API-ju
const allowedOrigins = [
    "https://ivaniandrijana.cloud",
    "https://www.ivaniandrijana.cloud"
];

if (process.env.NODE_ENV !== "production") {
    allowedOrigins.push("http://localhost", "http://localhost:3000");
}

app.use(
    cors({
        origin: allowedOrigins,
        methods: ["GET", "POST", "PATCH", "DELETE"], // Dozvoljeni HTTP metodi
        credentials: true // Dozvoljava slanje kolačića (cookies) preko CORS-a - neophodno za sesije
    })
);

app.use(express.json()); // Middleware koji parsira JSON telo zahteva u req.body

// ============================================================
// SESSION MIDDLEWARE (za admin login)
// ============================================================
const sessionDbPath = path.join(__dirname, "../../sessions.sqlite");

class SQLiteSessionStore extends session.Store {
    private readonly sessionDb: Database.Database;
    private readonly cleanupTimer: NodeJS.Timeout;

    constructor(filename: string) {
        super();
        this.sessionDb = new Database(filename);
        this.sessionDb.pragma("journal_mode = WAL");
        this.sessionDb.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                sid TEXT PRIMARY KEY,
                sess TEXT NOT NULL,
                expires INTEGER NOT NULL
            )
        `);
        this.cleanupTimer = setInterval(() => {
            try {
                this.sessionDb.prepare("DELETE FROM sessions WHERE expires <= ?").run(Date.now());
            } catch (error) {
                console.error("Greška pri čišćenju isteklih sesija:", error);
            }
        }, 60 * 60 * 1000);
        this.cleanupTimer.unref();
    }

    get(
        sid: string,
        callback: (err: unknown, value?: session.SessionData | null) => void
    ): void {
        try {
            const now = Date.now();

            const row = this.sessionDb
                .prepare("SELECT sess FROM sessions WHERE sid = ? AND expires > ?")
                .get(sid, now) as { sess: string } | undefined;

            callback(null, row ? (JSON.parse(row.sess) as session.SessionData) : null);
        } catch (error) {
            callback(error);
        }
    }

    set(sid: string, value: session.SessionData, callback?: (err?: unknown) => void): void {
        try {
            const expires = value.cookie.expires?.getTime() ?? Date.now() + 1000 * 60 * 60 * 12;

            this.sessionDb
                .prepare(`
                    INSERT INTO sessions (sid, sess, expires)
                    VALUES (?, ?, ?)
                    ON CONFLICT(sid) DO UPDATE SET
                        sess = excluded.sess,
                        expires = excluded.expires
                `)
                .run(sid, JSON.stringify(value), expires);

            callback?.();
        } catch (error) {
            callback?.(error);
        }
    }

    destroy(sid: string, callback?: (err?: unknown) => void): void {
        try {
            this.sessionDb.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
            callback?.();
        } catch (error) {
            callback?.(error);
        }
    }

    touch(sid: string, value: session.SessionData, callback?: (err?: unknown) => void): void {
        try {
            const expires = value.cookie.expires?.getTime() ?? Date.now() + 1000 * 60 * 60 * 12;
            this.sessionDb.prepare("UPDATE sessions SET expires = ? WHERE sid = ?").run(expires, sid);
            callback?.();
        } catch (error) {
            callback?.(error);
        }
    }

    close(): void {
        clearInterval(this.cleanupTimer);
        this.sessionDb.close();
    }
}

const sessionStore = new SQLiteSessionStore(sessionDbPath);

app.use(
    session({
        store: sessionStore,
        name: "wedding_admin_sid",                                  // Ime cookie-ja u kom se čuva session ID
        secret: SESSION_SECRET,
        resave: false,           // Ne snima sesiju nazad ako nije menjana
        saveUninitialized: false, // Ne kreira sesiju dok se nešto ne upiše u nju
        cookie: {
            httpOnly: true,                              // Cookie nije dostupan iz JavaScript-a (zaštita od XSS)
            secure: process.env.NODE_ENV === "production", // Cookie se šalje samo preko HTTPS-a u produkciji
            sameSite: "lax",                              // Zaštita od CSRF napada
            path: "/",
            maxAge: 1000 * 60 * 60 * 12                   // Trajanje sesije: 12 sati
        }
    })
);

// ============================================================
// RATE LIMITERI - ograničavanje broja zahteva
// ============================================================
// Ograničava broj upload zahteva po IP adresi (sprečava zloupotrebu/flooding)
const uploadLimiter = rateLimit({
    windowMs: 60 * 1000, // Vremenski prozor od 1 minuta
    max: 200,
    message: {
        error: "Previše zahteva. Pokušajte ponovo kasnije."
    }
});

const likeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: "Previše zahteva za lajkovanje."
    }
});

// Strožiji limiter za pokušaje admin logina (zaštita od brute-force napada)
const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // Vremenski prozor od 15 minuta
    max: 5,                    // Maksimalno 5 pokušaja logina u tom prozoru
    message: {
        error: "Previše pokušaja prijave. Pokušajte ponovo za 15 minuta."
    },
    standardHeaders: true,  // Dodaje standardne RateLimit-* header-e u odgovor
    legacyHeaders: false    // Isključuje stare X-RateLimit-* header-e
});

// ============================================================
// PUTANJE ZA FAJLOVE I BAZU PODATAKA
// ============================================================
const uploadFolderOriginal = path.join(__dirname, "../../uploads/original");           // Originalne slike
const uploadFolderThumbs = path.join(__dirname, "../../uploads/thumbs");               // Thumbnail-ovi slika
const uploadFolderVideosOriginal = path.join(__dirname, "../../uploads/videos/original"); // Originalni video fajlovi
const uploadFolderVideosThumbs = path.join(__dirname, "../../uploads/videos/thumbs");     // Thumbnail-ovi (frame) videa
const uploadFolderVideosWeb = path.join(__dirname, "../../uploads/videos/web");           // Web-optimizovane verzije videa
const dbPath = path.join(__dirname, "../../database.sqlite");                             // Putanja do SQLite baze

// Kreira potrebne foldere ako ne postoje (da aplikacija ne pukne pri prvom pokretanju)
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

// ============================================================
// INICIJALIZACIJA BAZE PODATAKA (SQLite)
// ============================================================
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");    // Write-Ahead Logging - bolje performanse i paralelno čitanje/pisanje
db.pragma("synchronous = NORMAL");  // Balans između performansi i sigurnosti podataka
db.pragma("busy_timeout = 5000");   // Čeka do 5 sekundi ako je baza zauzeta pre nego što baci grešku

// Kreira tabelu "photos" ako ne postoji - glavna tabela za slike/video
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

// ============================================================
// MIGRACIJE ŠEME - dodavanje novih kolona ako ne postoje
// ============================================================
// Ovo omogućava da se aplikacija ažurira bez brisanja postojeće baze -
// proverava se koje kolone već postoje i dodaju se samo one koje nedostaju

const existingColumns = db.prepare(`PRAGMA table_info(photos)`).all() as { name: string }[];

const hasAiScore = existingColumns.some((col) => col.name === "ai_score");
const hasAiReason = existingColumns.some((col) => col.name === "ai_reason");

// ai_score - numerička ocena AI moderacije (koliko je sadržaj "rizičan")
if (!hasAiScore) {
    db.exec(`ALTER TABLE photos ADD COLUMN ai_score INTEGER NOT NULL DEFAULT 0`);
}

// ai_reason - tekstualno obrazloženje zašto je AI označio sliku/video na određeni način
if (!hasAiReason) {
    db.exec(`ALTER TABLE photos ADD COLUMN ai_reason TEXT NOT NULL DEFAULT ''`);
}

const hasMediaType = existingColumns.some((col) => col.name === "media_type");

// media_type - da li je fajl "image" ili "video"
if (!hasMediaType) {
    db.exec(`
        ALTER TABLE photos
        ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image'
    `);
}

const hasWebUrl = existingColumns.some((col) => col.name === "web_url");

// web_url - putanja do web-optimizovane (komprimovane) verzije videa za striming/pregled
if (!hasWebUrl) {
    db.exec(`
        ALTER TABLE photos
        ADD COLUMN web_url TEXT NOT NULL DEFAULT ''
    `);

    console.log("Dodata kolona web_url");
}

const hasLikes = existingColumns.some((col) => col.name === "likes");

// likes - brojač lajkova po fotografiji/videu
if (!hasLikes) {
    db.exec(`
        ALTER TABLE photos
        ADD COLUMN likes INTEGER NOT NULL DEFAULT 0
    `);

    console.log("Dodata kolona likes");
}

// Tabela koja beleži KO je (po client_id) lajkovao KOJU fotografiju,
// da bi se sprečilo višestruko lajkovanje sa istog uređaja
db.exec(`
    CREATE TABLE IF NOT EXISTS photo_likes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        photo_id INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(photo_id, client_id)
    );
`);

// Tabela administratora (za login u admin panel)
db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
`);

// ============================================================
// KREIRANJE PODRAZUMEVANOG ADMINISTRATORA
// ============================================================
// Proverava da li već postoji admin korisnik "admin" u bazi
const adminExists = db
    .prepare(
        `
    SELECT id
    FROM admins
    LIMIT 1
`
    )
    .get();

// Ako ne postoji, kreira ga sa podrazumevanom lozinkom (heširanom pomoću bcrypt)
// NAPOMENA: ovu lozinku treba promeniti odmah nakon prvog pokretanja u produkciji
if (!adminExists) {
    const defaultAdminUsername = process.env.DEFAULT_ADMIN_USERNAME?.trim();
    const defaultAdminPassword = process.env.DEFAULT_ADMIN_PASSWORD;

    if (!defaultAdminUsername || !defaultAdminPassword || defaultAdminPassword.length < 12) {
        throw new Error(
            "Baza nema administratora. Definišite DEFAULT_ADMIN_USERNAME i DEFAULT_ADMIN_PASSWORD od najmanje 12 karaktera."
        );
    }

    const passwordHash = bcrypt.hashSync(defaultAdminPassword, 12);

    db.prepare(
        `
        INSERT INTO admins (
            username,
            password_hash,
            created_at
        )
        VALUES (?, ?, ?)
    `
    ).run(defaultAdminUsername, passwordHash, new Date().toISOString());

    console.log("Kreiran podrazumevani administrator.");
}

// ============================================================
// STATIČKI FAJLOVI - direktno serviranje uploadovanih slika/videa
// ============================================================
// Sve iz foldera "uploads" postaje dostupno preko /uploads/... URL putanje
app.use("/uploads", (req, res, next) => {
    const mediaUrl = `/uploads${req.path}`;
    const photo = db
        .prepare(`
            SELECT status
            FROM photos
            WHERE original_url = ? OR thumb_url = ? OR web_url = ?
        `)
        .get(mediaUrl, mediaUrl, mediaUrl) as { status: string } | undefined;

    if (!photo || (photo.status !== "approved" && !req.session.adminId)) {
        return res.status(404).end();
    }

    next();
});
app.use("/uploads", express.static(path.join(__dirname, "../../uploads")));

// ============================================================
// MULTER KONFIGURACIJA - upload fajlova
// ============================================================
// Definiše GDE i POD KOJIM IMENOM se sačuvava uploadovani fajl
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Video fajlovi idu u poseban folder od slika
        if (file.mimetype.startsWith("video/")) {
            cb(null, uploadFolderVideosOriginal);
            return;
        }

        cb(null, uploadFolderOriginal);
    },
    filename: (req, file, cb) => {
        // Generiše jedinstveno ime fajla: timestamp + random broj + originalna ekstenzija
        // (sprečava kolizije imena i prepisivanje postojećih fajlova)
        const uniqueName =
            Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname).toLowerCase();

        cb(null, uniqueName);
    }
});

// Filter koji proverava da li je fajl dozvoljenog tipa (slika ili video)
// pre nego što se upload uopšte prihvati - proverava i MIME tip i ekstenziju
const fileFilter = (req: any, file: Express.Multer.File, cb: Function) => {
    const allowedImageExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
    const allowedVideoExtensions = [".mp4", ".mov", ".webm", ".avi", ".mkv"];

    const ext = path.extname(file.originalname).toLowerCase();

    const isImage = file.mimetype.startsWith("image/") && allowedImageExtensions.includes(ext);

    const isVideo = file.mimetype.startsWith("video/") && allowedVideoExtensions.includes(ext);

    if (isImage || isVideo) {
        cb(null, true); // Fajl je prihvaćen
        return;
    }

    cb(new Error("Dozvoljene su samo slike i video fajlovi"), false); // Fajl je odbijen
};

// Kreira multer instancu sa definisanim storage-om, filterom i limitom veličine fajla
const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 500 * 1024 * 1024 // Maksimalna veličina fajla: 500 MB
    }
});

// ============================================================
// AI MODERACIJA - RED ČEKANJA (QUEUE) ZA OBRADU SLIKA
// ============================================================
// Ovo garantuje da se AI moderacija slika izvršava JEDNA PO JEDNA (sekvencijalno),
// a ne paralelno za sve upload-ovane slike istovremeno (štedi resurse/API pozive)
let aiJobCounter = 0;
let aiQueue = Promise.resolve(); // "Rep" (tail) promise-a koji predstavlja trenutni kraj reda

function runAiModerationQueued(filePath: string) {
    const jobId = ++aiJobCounter; // Jedinstveni ID posla radi logovanja

    console.log("AI queue čeka:", jobId, path.basename(filePath));

    // Novi posao se "kači" na prethodni u nizu - izvršiće se tek kad se prethodni završi
    const job = aiQueue.then(async () => {
        console.log("AI queue počinje:", jobId, path.basename(filePath));

        const result = await moderateImage(filePath); // Poziv AI moderacije (eksterni modul)

        console.log("AI queue završena:", jobId, path.basename(filePath), result.status, result.aiScore);

        return result;
    });

    // Ažurira "rep" reda na trenutni posao (bez obzira na uspeh/neuspeh - catch hvata grešku da ne blokira red)
    aiQueue = job.then(() => undefined).catch(() => undefined);

    return job;
}

// ============================================================
// VIDEO OBRADA - RED ČEKANJA (QUEUE) ZA FFMPEG POSLOVE
// ============================================================
// Isti princip kao AI queue - video obrada (konverzija/thumbnail) ide sekvencijalno
// jer je ffmpeg resursno zahtevan (CPU/memorija) pa se ne žele paralelni poslovi
let videoQueue = Promise.resolve();

function enqueueVideoJob(job: () => Promise<void>) {
    videoQueue = videoQueue.then(job).catch((error) => {
        console.error("Video queue greška:", error);
    });

    return videoQueue;
}

// Pokreće ffmpeg komandu preko "nice" (niži prioritet procesa da ne uguši server)
function runNiceFfmpeg(args: string[]) {
    return new Promise<void>((resolve, reject) => {
        const handleResult = (error: Error | null, stderr: string) => {
            if (error) {
                reject(new Error(`FFmpeg nije uspeo: ${stderr.trim() || error.message}`, { cause: error }));
                return;
            }

            resolve();
        };

        execFile("nice", ["-n", "10", "ffmpeg", ...args], (error, _stdout, stderr) => {
            if (error && "code" in error && error.code === "ENOENT") {
                execFile("ffmpeg", args, (fallbackError, _fallbackStdout, fallbackStderr) => {
                    handleResult(fallbackError, fallbackStderr);
                });
                return;
            }

            handleResult(error, stderr);
        });
    });
}

let videoJobCounter = 0;

// Stavlja video obradu u red čekanja i pokreće je kad dođe na red
function processVideoInBackground(photoId: number, filePath: string, filename: string): Promise<void> {
    const jobId = ++videoJobCounter;

    console.log("VIDEO QUEUE ČEKA:", jobId, photoId, filename);

    return enqueueVideoJob(async () => {
        console.log("VIDEO QUEUE POČINJE:", jobId, photoId, filename);

        await processVideoJob(photoId, filePath, filename);

        console.log("VIDEO QUEUE ZAVRŠENA:", jobId, photoId, filename);
    });
}

// Stvarna obrada videa: generiše thumbnail (jedan frame) i web-optimizovanu verziju,
// pa ažurira bazu sa novim putanjama nakon završetka obrade
async function processVideoJob(photoId: number, filePath: string, filename: string) {
    const videoThumbName = filename + ".jpg";
    const videoThumbPath = path.join(uploadFolderVideosThumbs, videoThumbName);

    const webVideoName = `${path.parse(filename).name}.mp4`;
    const webVideoPath = path.join(uploadFolderVideosWeb, webVideoName);

    const thumbUrl = `/uploads/videos/thumbs/${videoThumbName}`;
    const webUrl = `/uploads/videos/web/${webVideoName}`;

    console.log("Pokrećem queued video obradu:", photoId, filename);

    try {
        // Prvo pokušava frejm na 1. sekundi; za veoma kratke snimke koristi prvi frejm.
        const thumbnailArgs = (seekToOneSecond: boolean) => [
            "-y",
            "-i",
            filePath,
            ...(seekToOneSecond ? ["-ss", "00:00:01"] : []),
            "-frames:v",
            "1",
            "-vf",
            "scale=400:400:force_original_aspect_ratio=increase,crop=400:400",
            videoThumbPath
        ];
        const thumbnailExists = () =>
            fs.existsSync(videoThumbPath) && fs.statSync(videoThumbPath).size > 0;

        try {
            await runNiceFfmpeg(thumbnailArgs(true));
        } catch (thumbnailError) {
            console.warn("Thumbnail na 1. sekundi nije napravljen, pokušavam prvi frejm:", thumbnailError);
        }

        if (!thumbnailExists()) {
            if (fs.existsSync(videoThumbPath)) {
                fs.unlinkSync(videoThumbPath);
            }
            await runNiceFfmpeg(thumbnailArgs(false));
        }

        if (!thumbnailExists()) {
            throw new Error("FFmpeg nije napravio video thumbnail.");
        }

        // 2. korak: konvertuje video u web-optimizovan MP4 (H.264 + AAC)
        await runNiceFfmpeg([
            "-y",
            "-i",
            filePath,
            "-vf",
            "scale='min(1280,iw)':-2",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "28",
            "-movflags",
            "+faststart",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-threads",
            "2",
            "-f",
            "mp4",
            webVideoPath
        ]);

        if (!fs.existsSync(webVideoPath) || fs.statSync(webVideoPath).size === 0) {
            throw new Error("FFmpeg nije napravio web MP4 verziju.");
        }

        // Nakon obrade, ažurira bazu sa putanjama do thumbnail-a i web verzije videa
        const updateResult = db.prepare(
        `
        UPDATE photos
        SET
            thumb_url = ?,
            web_url = ?,
            ai_reason = ?
        WHERE id = ?
    `
        ).run(thumbUrl, webUrl, "Video fajl - web verzija spremna, ručni pregled potreban", photoId);

        if (updateResult.changes === 0) {
            for (const generatedPath of [videoThumbPath, webVideoPath]) {
                if (fs.existsSync(generatedPath)) {
                    fs.unlinkSync(generatedPath);
                }
            }
            return;
        }

        console.log("Queued video obrada završena:", photoId);
    } catch (error) {
        for (const generatedPath of [videoThumbPath, webVideoPath]) {
            try {
                if (fs.existsSync(generatedPath)) {
                    fs.unlinkSync(generatedPath);
                }
            } catch (cleanupError) {
                console.error("Greška pri čišćenju neuspele video obrade:", generatedPath, cleanupError);
            }
        }

        try {
            db.prepare(`
                UPDATE photos
                SET ai_reason = ?
                WHERE id = ?
            `).run("Video fajl - obrada nije uspela, ručni pregled potreban", photoId);
        } catch (dbError) {
            console.error("Nije moguće evidentirati neuspešnu video obradu:", dbError);
        }

        throw error;
    }
}

// ============================================================
// MIDDLEWARE ZA ZAŠTITU ADMIN RUTA
// ============================================================
// Proverava da li postoji aktivna admin sesija pre nego što dozvoli pristup ruti
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (!req.session.adminId) {
        return res.status(401).json({
            error: "Unauthorized"
        });
    }

    next();
}

const trustedAdminOrigins = new Set(allowedOrigins);

function requireTrustedAdminOrigin(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) {
    if (!["POST", "PATCH", "DELETE"].includes(req.method)) {
        next();
        return;
    }

    const sourceHeader = req.get("origin") ?? req.get("referer");

    if (!sourceHeader) {
        return res.status(403).json({
            error: "Zahtev nema dozvoljeno poreklo."
        });
    }

    try {
        const sourceOrigin = new URL(sourceHeader).origin;

        if (!trustedAdminOrigins.has(sourceOrigin)) {
            return res.status(403).json({
                error: "Zahtev nema dozvoljeno poreklo."
            });
        }
    } catch {
        return res.status(403).json({
            error: "Zahtev nema dozvoljeno poreklo."
        });
    }

    next();
}

app.use("/api/admin", requireTrustedAdminOrigin);

function parsePositiveId(value: string | string[] | undefined): number | null {
    if (typeof value !== "string") {
        return null;
    }
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// ============================================================
// RUTA: POST /api/upload - upload slike ili videa
// ============================================================
app.post("/api/upload", uploadLimiter, upload.single("photo"), async (req, res) => {
    const file = req.file;

    if (!file) {
        return res.status(400).json({
            error: "Nijedan fajl nije poslat."
        });
    }

    const ext = path.extname(file.originalname).toLowerCase();

    // Utvrđuje da li je fajl video (po MIME tipu ili ekstenziji, kao dodatna provera)
    const isVideo = file.mimetype.startsWith("video/") || [".mp4", ".mov", ".webm", ".avi", ".mkv"].includes(ext);

    const mediaType = isVideo ? "video" : "image";
    let storedFilename = file.filename;
    let storedFilePath = file.path;

    console.log("Fajl primljen:", file.filename, mediaType);

    try {
        let originalUrl = "";
        let thumbUrl = "";
        let webUrl = "";
        let status = "approved";
        let aiScore = 0;
        let aiReason = "";

        if (isVideo) {
            // Za video: obrada (thumbnail + konverzija) se radi u pozadini (queue),
            // pa se video odmah stavlja u status "pending_review" dok ne prođe ručni pregled
            originalUrl = `/uploads/videos/original/${file.filename}`;
            thumbUrl = "";
            webUrl = "";

            status = "pending_review";
            aiScore = 0;
            aiReason = "Video fajl - obrada u toku, ručni pregled potreban";
        } else {
            // Za sliku: sinhrona obrada odmah pri uploadu
            storedFilename = `${path.parse(file.filename).name}.jpg`;
            storedFilePath = path.join(uploadFolderOriginal, storedFilename);
            const processedImagePath = storedFilePath + ".processing";
            const thumbPath = path.join(uploadFolderThumbs, storedFilename);

            // Ispravlja orijentaciju slike (EXIF rotate) i re-enkodira u JPEG visokog kvaliteta
            await sharp(file.path)
                .rotate()
                .jpeg({ quality: 95 })
                .toFile(processedImagePath);

            fs.unlinkSync(file.path);
            fs.renameSync(processedImagePath, storedFilePath);

            // Pravi kvadratni thumbnail (400x400, "cover" - seče višak da ispuni kvadrat)
            await sharp(storedFilePath)
                .resize({
                    width: 400,
                    height: 400,
                    fit: "cover"
                })
                .jpeg({ quality: 80 })
                .toFile(thumbPath);

            originalUrl = `/uploads/original/${storedFilename}`;
            thumbUrl = `/uploads/thumbs/${storedFilename}`;

            // Pokreće AI moderaciju slike (u redu čekanja) - određuje da li je slika prikladna
            const moderation = await runAiModerationQueued(storedFilePath);

            status = moderation.status;       // npr. "approved" ili "pending_review"
            aiScore = moderation.aiScore;     // numerička ocena AI-ja
            aiReason = moderation.aiReason;   // razlog/obrazloženje AI ocene
        }

        // Upisuje novi zapis u bazu podataka sa svim informacijama o fajlu
        const insertResult = db
            .prepare(
                `
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
        `
            )
            .run(
                storedFilename,
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

        // Ako fajl čeka pregled, šalje email obaveštenje administratoru
        if (status === "pending_review") {
            sendPendingReviewEmail(insertedId, storedFilename);
        }

        // Ako je video, pokreće se pozadinska obrada (thumbnail + konverzija)
        if (isVideo) {
            void processVideoInBackground(insertedId, file.path, file.filename);
        }

        // Vraća odgovor klijentu sa informacijama o uploadovanom fajlu
        res.json({
            message: isVideo
                ? "Video je uploadovan i obrada je pokrenuta u pozadini."
                : "Slika i thumbnail uspešno uploadovani!",
            filename: storedFilename,
            mediaType,
            originalUrl,
            thumbUrl,
            webUrl,
            status
        });
    } catch (error) {
        // U slučaju greške, briše sve delimično kreirane fajlove (originalni, .fixed privremeni, thumbnail)
        console.error("Greška pri obradi fajla:", error);

        const cleanupPaths = [
            file.path,
            storedFilePath,
            storedFilePath + ".processing",
            path.join(uploadFolderThumbs, storedFilename)
        ];

        for (const cleanupPath of cleanupPaths) {
            try {
                if (fs.existsSync(cleanupPath)) {
                    fs.unlinkSync(cleanupPath);
                }
            } catch (cleanupError) {
                console.error("Greška pri brisanju neuspelog fajla:", cleanupPath, cleanupError);
            }
        }

        // Proverava da li je greška vezana za nevalidan/oštećen fajl (da vrati 400 umesto 500)
        const errorMessage = error instanceof Error ? error.message.toLowerCase() : "";

        const invalidMedia =
            errorMessage.includes("unsupported image format") ||
            errorMessage.includes("input file") ||
            errorMessage.includes("invalid") ||
            errorMessage.includes("corrupt");

        if (invalidMedia) {
            return res.status(400).json({
                error: "Fajl nije validna ili podržana slika."
            });
        }

        return res.status(500).json({
            error: "Greška pri obradi fajla."
        });
    }
});

// ============================================================
// RUTA: GET /api/photos - javna lista odobrenih slika/videa (sa paginacijom)
// ============================================================
app.get("/api/photos", (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);          // Broj stranice (min 1)
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100); // Broj rezultata po stranici (1-100)
    const offset = (page - 1) * limit;

    // Vraća samo fotografije/videe sa statusom "approved", sortirane od najnovijih
    const photos = db
        .prepare(
            `
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
    `
        )
        .all(limit, offset);

    // Ukupan broj odobrenih fotografija (za izračunavanje "hasMore")
    const total = db
        .prepare(
            `
        SELECT COUNT(*) AS count
        FROM photos
        WHERE status = 'approved'
    `
        )
        .get() as { count: number };

    res.json({
        photos,
        page,
        limit,
        total: total.count,
        hasMore: offset + photos.length < total.count // Da li ima još stranica za učitavanje
    });
});

// ============================================================
// RUTA: GET /api/photos/:id/download - preuzimanje originalnog fajla
// ============================================================
app.get("/api/photos/:id/download", (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (id === null) {
        return res.status(400).json({ error: "Neispravan ID." });
    }

    // Pronalazi fotografiju/video po ID-ju, samo ako je odobrena (approved)
    const photo = db
        .prepare(
            `
 SELECT
        id,
        filename,
        media_type AS mediaType,
        thumb_url AS thumbUrl,
        web_url AS webUrl
    FROM photos
    WHERE id = ?
    AND status = 'approved'
`
        )
        .get(id) as
        | {
              id: number;
              filename: string;
              mediaType: string;
              thumbUrl: string;
              webUrl: string;
          }
        | undefined;

    if (!photo) {
        return res.status(404).json({
            error: "Slika nije pronađena."
        });
    }

    // Bira folder u zavisnosti od tipa medija (slika ili video)
    const filePath = path.join(
        photo.mediaType === "video" ? uploadFolderVideosOriginal : uploadFolderOriginal,
        photo.filename
    );

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({
            error: "Fajl ne postoji."
        });
    }

    // Povećava brojač preuzimanja pre slanja fajla
    db.prepare(
        `
        UPDATE photos
        SET downloads = downloads + 1
        WHERE id = ?
    `
    ).run(id);

    return res.download(filePath, photo.filename); // Šalje fajl klijentu kao download
});

// ============================================================
// RUTA: POST /api/photos/:id/like - lajkovanje fotografije/videa
// ============================================================
app.post("/api/photos/:id/like", likeLimiter, (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (id === null) {
        return res.status(400).json({ error: "Neispravan ID." });
    }
    const clientId = String(req.body.clientId || "").trim(); // Jedinstveni identifikator uređaja/klijenta (šalje frontend)

    if (
        clientId.length < 16 ||
        clientId.length > 128 ||
        !/^[a-zA-Z0-9_-]+$/.test(clientId)
    ) {
        return res.status(400).json({
            error: "Neispravan clientId."
        });
    }

    // Proverava da li fotografija postoji i da li je odobrena
    const photo = db
        .prepare(
            `
        SELECT id, likes
        FROM photos
        WHERE id = ?
        AND status = 'approved'
    `
        )
        .get(id) as { id: number; likes: number } | undefined;

    if (!photo) {
        return res.status(404).json({
            error: "Fajl nije pronađen."
        });
    }

    const addLike = db.transaction((photoId: number, likerClientId: string) => {
        db.prepare(
            `
            INSERT INTO photo_likes (
                photo_id,
                client_id,
                created_at
            ) VALUES (?, ?, ?)
        `
        ).run(photoId, likerClientId, new Date().toISOString());

        const updateResult = db.prepare(
            `
            UPDATE photos
            SET likes = likes + 1
            WHERE id = ?
        `
        ).run(photoId);

        if (updateResult.changes !== 1) {
            throw new Error("Fotografija nije ažurirana tokom lajkovanja.");
        }
    });

    try {
        addLike(id, clientId);
    } catch (error) {
        const isDuplicateLike =
            error instanceof Error &&
            "code" in error &&
            error.code === "SQLITE_CONSTRAINT_UNIQUE";

        if (!isDuplicateLike) {
            console.error("Neočekivana greška pri lajkovanju:", error);
            return res.status(500).json({
                error: "Lajkovanje trenutno nije moguće."
            });
        }
    }

    // Vraća trenutni (ažurirani ili nepromenjeni) broj lajkova
    const updated = db
        .prepare(
            `
        SELECT likes
        FROM photos
        WHERE id = ?
    `
        )
        .get(id) as { likes: number };

    res.json({
        id,
        likes: updated.likes,
        liked: true
    });
});

// ============================================================
// RUTA: POST /api/admin/login - prijava administratora
// ============================================================
app.post("/api/admin/login", adminLoginLimiter, async (req, res) => {
    const { username, password } = req.body;

    if (
        typeof username !== "string" ||
        typeof password !== "string" ||
        !username.trim() ||
        !password
    ) {
        return res.status(400).json({
            error: "Username i password su obavezni."
        });
    }

    const normalizedUsername = username.trim();

    if (normalizedUsername.length > 100 || password.length > 200) {
        return res.status(400).json({
            error: "Neispravni kredencijali."
        });
    }

    // Traži admina po username-u
    const admin = db
        .prepare(
            `
        SELECT *
        FROM admins
        WHERE username = ?
    `
        )
        .get(normalizedUsername) as any;

    if (!admin) {
        return res.status(401).json({
            error: "Pogrešni kredencijali."
        });
    }

    // Poredi unetu lozinku sa heširanom lozinkom iz baze
    const validPassword = await bcrypt.compare(password, admin.password_hash);

    if (!validPassword) {
        return res.status(401).json({
            error: "Pogrešni kredencijali."
        });
    }

    // Regeneracija sprečava session fixation nakon uspešne autentikacije.
    req.session.regenerate((error) => {
        if (error) {
            console.error("Greška pri regeneraciji admin sesije:", error);
            return res.status(500).json({
                error: "Prijava trenutno nije moguća."
            });
        }

        req.session.adminId = admin.id;
        req.session.username = admin.username;

        req.session.save((saveError) => {
            if (saveError) {
                console.error("Greška pri čuvanju admin sesije:", saveError);
                return res.status(500).json({
                    error: "Prijava trenutno nije moguća."
                });
            }

            res.json({
                success: true,
                username: admin.username
            });
        });
    });
});

// ============================================================
// RUTA: GET /api/admin/me - podaci o trenutno prijavljenom adminu
// ============================================================
app.get("/api/admin/me", requireAdmin, (req, res) => {
    res.json({
        id: req.session.adminId,
        username: req.session.username
    });
});

// ============================================================
// RUTA: POST /api/admin/logout - odjava administratora
// ============================================================
app.post("/api/admin/logout", requireAdmin, (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            return res.status(500).json({
                error: "Logout nije uspeo."
            });
        }

        res.clearCookie("wedding_admin_sid", {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            path: "/"
        });

        res.json({
            success: true
        });
    });
});

// ============================================================
// RUTA: GET /api/admin/photos - admin lista SVIH slika/videa (bez obzira na status)
// ============================================================
app.get("/api/admin/photos", requireAdmin, (req, res) => {
    const photos = db
        .prepare(
            `
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
    `
        )
        .all();
    // Sortira tako da prvo idu one koje čekaju pregled (najbitnije za admina),
    // zatim odobrene, pa sakrivene, po najnovijim prvo unutar svake grupe

    res.json({ photos });
});

// ============================================================
// RUTA: GET /api/admin/stats - statistika za admin dashboard
// ============================================================
app.get("/api/admin/stats", requireAdmin, (req, res) => {
    const stats = db
        .prepare(
            `
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
            SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'hidden' THEN 1 ELSE 0 END) AS hidden,
            COALESCE(SUM(downloads), 0) AS downloads
        FROM photos
    `
        )
        .get();

    res.json({ stats });
});

// ============================================================
// RUTA: PATCH /api/admin/photos/:id/hide - sakrivanje fotografije/videa
// ============================================================
app.patch("/api/admin/photos/:id/hide", requireAdmin, (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (id === null) {
        return res.status(400).json({ error: "Neispravan ID." });
    }

    const result = db
        .prepare(
            `
        UPDATE photos
        SET status = 'hidden'
        WHERE id = ?
    `
        )
        .run(id);

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

// ============================================================
// RUTA: PATCH /api/admin/photos/:id/pending - vraćanje na status "čeka pregled"
// ============================================================
app.patch("/api/admin/photos/:id/pending", requireAdmin, (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (id === null) {
        return res.status(400).json({ error: "Neispravan ID." });
    }

    // Prvo dohvata trenutni status da bi znao da li treba poslati email
    // (ne šalje se ponovo email ako je fajl već bio u statusu pending_review)
    const photo = db
        .prepare(
            `
        SELECT
            id,
            filename,
            status
        FROM photos
        WHERE id = ?
    `
        )
        .get(id) as { id: number; filename: string; status: string } | undefined;

    if (!photo) {
        return res.status(404).json({
            error: "Slika nije pronađena."
        });
    }

    const result = db
        .prepare(
            `
        UPDATE photos
        SET status = 'pending_review'
        WHERE id = ?
    `
        )
        .run(id);

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

// ============================================================
// RUTA: PATCH /api/admin/photos/:id/approve - odobravanje fotografije/videa
// ============================================================
app.patch("/api/admin/photos/:id/approve", requireAdmin, (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (id === null) {
        return res.status(400).json({ error: "Neispravan ID." });
    }

    const photo = db
        .prepare(`
            SELECT
                id,
                media_type AS mediaType,
                thumb_url AS thumbUrl,
                web_url AS webUrl
            FROM photos
            WHERE id = ?
        `)
        .get(id) as
        | {
              id: number;
              mediaType: string;
              thumbUrl: string;
              webUrl: string;
          }
        | undefined;

    if (!photo) {
        return res.status(404).json({
            error: "Fajl nije pronađen."
        });
    }

    if (photo.mediaType === "video" && (!photo.thumbUrl || !photo.webUrl)) {
        return res.status(409).json({
            error: "Video obrada još nije završena."
        });
    }

    const result = db
        .prepare(
            `
        UPDATE photos
        SET status = 'approved'
        WHERE id = ?
    `
        )
        .run(id);

    res.json({
        message: "Slika je odobrena.",
        id,
        status: "approved"
    });
});

// ============================================================
// RUTA: DELETE /api/admin/photos/:id - trajno brisanje fotografije/videa
// ============================================================
app.delete("/api/admin/photos/:id", requireAdmin, (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (id === null) {
        return res.status(400).json({ error: "Neispravan ID." });
    }

    // Pronalazi fajl da bi znao putanje originala i thumbnaila za brisanje sa diska
    const photo = db
        .prepare(
            `
    SELECT
        id,
        filename,
        media_type AS mediaType,
        thumb_url AS thumbUrl,
        web_url AS webUrl
    FROM photos
    WHERE id = ?
`
        )
        .get(id) as
        | {
              id: number;
              filename: string;
              mediaType: string;
              thumbUrl: string;
              webUrl: string;
          }
        | undefined;

    if (!photo) {
        return res.status(404).json({
            error: "Slika nije pronađena."
        });
    }

    // Bira odgovarajuće foldere u zavisnosti od tipa medija
    const originalPath = path.join(
        photo.mediaType === "video" ? uploadFolderVideosOriginal : uploadFolderOriginal,
        photo.filename
    );

    const thumbPath = path.join(
        photo.mediaType === "video" ? uploadFolderVideosThumbs : uploadFolderThumbs,
        path.basename(photo.thumbUrl || (photo.mediaType === "video" ? photo.filename + ".jpg" : photo.filename))
    );
    const webPath =
        photo.mediaType === "video" && photo.webUrl
            ? path.join(uploadFolderVideosWeb, path.basename(photo.webUrl))
            : null;

    const stagedFiles: { originalPath: string; stagedPath: string }[] = [];

    try {
        for (const filePath of [originalPath, thumbPath, webPath]) {
            if (filePath && fs.existsSync(filePath)) {
                const stagedPath = `${filePath}.deleting-${id}-${Date.now()}`;
                fs.renameSync(filePath, stagedPath);
                stagedFiles.push({ originalPath: filePath, stagedPath });
            }
        }

        const deleteMedia = db.transaction((photoId: number) => {
            db.prepare("DELETE FROM photo_likes WHERE photo_id = ?").run(photoId);
            db.prepare("DELETE FROM photos WHERE id = ?").run(photoId);
        });

        deleteMedia(id);

        for (const stagedFile of stagedFiles) {
            try {
                fs.unlinkSync(stagedFile.stagedPath);
            } catch (cleanupError) {
                console.error("Privremeni obrisani fajl nije uklonjen:", stagedFile.stagedPath, cleanupError);
            }
        }

        res.json({
            message: "Slika je obrisana.",
            id
        });
    } catch (error) {
        for (const stagedFile of [...stagedFiles].reverse()) {
            try {
                if (fs.existsSync(stagedFile.stagedPath) && !fs.existsSync(stagedFile.originalPath)) {
                    fs.renameSync(stagedFile.stagedPath, stagedFile.originalPath);
                }
            } catch (restoreError) {
                console.error("Greška pri vraćanju fajla nakon neuspelog brisanja:", stagedFile, restoreError);
            }
        }

        console.error("Greška pri brisanju slike:", error);

        res.status(500).json({
            error: "Greška pri brisanju slike."
        });
    }
});

// ============================================================
// RUTA: GET /api/admin/download/photos - preuzimanje SVIH odobrenih slika kao ZIP
// ============================================================
app.get("/api/admin/download/photos", requireAdmin, (req, res) => {
    // Dohvata sve odobrene slike (ne i videe)
    const photos = db
        .prepare(
            `
        SELECT filename
        FROM photos
        WHERE status = 'approved'
        AND media_type = 'image'
    `
        )
        .all() as { filename: string }[];

    // Postavlja header-e da browser tretira odgovor kao download ZIP fajla
    res.setHeader("Content-Disposition", `attachment; filename="wedding-photos.zip"`);

    res.setHeader("Content-Type", "application/zip");

    // Kreira ZIP arhivu u hodu (streaming) - ne pravi privremeni fajl na disku
    const archive = new archiver.ZipArchive({
        zlib: { level: 9 } // Maksimalni nivo kompresije
    });

    archive.on("warning", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
            console.warn("ZIP preskače fajl koji ne postoji:", error.message);
            return;
        }
        archive.emit("error", error);
    });
    archive.on("error", (error: Error) => {
        console.error("Greška pri pravljenju ZIP arhive fotografija:", error);
        res.destroy(error);
    });
    res.on("close", () => {
        if (!res.writableEnded) {
            archive.abort();
        }
    });

    archive.pipe(res); // Šalje sadržaj arhive direktno kao HTTP odgovor

    // Dodaje svaki fajl koji postoji na disku u arhivu
    photos.forEach((photo) => {
        const filePath = path.join(uploadFolderOriginal, photo.filename);

        if (fs.existsSync(filePath)) {
            archive.file(filePath, { name: photo.filename });
        }
    });

    void archive.finalize().catch((error: Error) => {
        console.error("ZIP arhiva fotografija nije završena:", error);
        res.destroy(error);
    });
});

// ============================================================
// RUTA: GET /api/admin/download/videos - preuzimanje SVIH odobrenih videa kao ZIP
// ============================================================
app.get("/api/admin/download/videos", requireAdmin, (req, res) => {
    // Isti princip kao ruta za slike, samo za video fajlove
    const videos = db
        .prepare(
            `
        SELECT filename
        FROM photos
        WHERE status = 'approved'
        AND media_type = 'video'
    `
        )
        .all() as { filename: string }[];

    res.setHeader("Content-Disposition", `attachment; filename="wedding-videos.zip"`);

    res.setHeader("Content-Type", "application/zip");

    const archive = new archiver.ZipArchive({
        zlib: { level: 9 }
    });

    archive.on("warning", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
            console.warn("ZIP preskače fajl koji ne postoji:", error.message);
            return;
        }
        archive.emit("error", error);
    });
    archive.on("error", (error: Error) => {
        console.error("Greška pri pravljenju ZIP arhive videa:", error);
        res.destroy(error);
    });
    res.on("close", () => {
        if (!res.writableEnded) {
            archive.abort();
        }
    });

    archive.pipe(res);

    videos.forEach((video) => {
        const filePath = path.join(uploadFolderVideosOriginal, video.filename);

        if (fs.existsSync(filePath)) {
            archive.file(filePath, { name: video.filename });
        }
    });

    void archive.finalize().catch((error: Error) => {
        console.error("ZIP arhiva videa nije završena:", error);
        res.destroy(error);
    });
});

// ============================================================
// RUTA: GET /api/health - health check (provera da li server radi)
// ============================================================
// Korisno za monitoring alate (npr. uptime robot, load balancer health check)
app.get("/api/health", (req, res) => {
    res.json({
        status: "ok",
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// ============================================================
// GLOBALNI ERROR HANDLER MIDDLEWARE
// ============================================================
// Express prepoznaje ovu funkciju kao error handler zato što ima 4 parametra (err, req, res, next).
// Hvata sve greške koje se dese u prethodnim middleware-ima/rutama (uključujući multer greške)
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("ERROR:", err);

    // Specifično rukovanje Multer greškama (upload)
    if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({
                error: "Fajl je prevelik. Maksimalna veličina je 500 MB."
            });
        }

        if (err.code === "LIMIT_UNEXPECTED_FILE") {
            return res.status(400).json({
                error: "Neočekivano upload polje. Koristi polje 'photo'."
            });
        }

        return res.status(400).json({
            error: "Neispravan upload zahtev.",
            code: err.code
        });
    }

    // Greška iz fileFilter-a (nedozvoljen tip fajla)
    if (err instanceof Error && err.message === "Dozvoljene su samo slike i video fajlovi") {
        return res.status(415).json({
            error: "Dozvoljene su samo slike i video fajlovi."
        });
    }

    // Sve ostale neočekivane greške
    return res.status(500).json({
        error: "Internal server error"
    });
});

// ============================================================
// POKRETANJE SERVERA
// ============================================================
// Server sluša SAMO na 127.0.0.1 (localhost) - podrazumeva se da je
// ispred njega reverse proxy (npr. nginx) koji ga izlaže na internet
const server = app.listen(PORT, "127.0.0.1", () => {
    console.log(`Server radi na portu ${PORT}`);
});

server.on("error", (error) => {
    console.error("SERVER ERROR:", error);
});

// ============================================================
// GRACEFUL SHUTDOWN - uredno gašenje servera
// ============================================================
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
    if (isShuttingDown) {
        return;
    }

    isShuttingDown = true;
    console.log(`${signal} primljen`);

    try {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });

        await Promise.allSettled([aiQueue, videoQueue]);
        db.close();
        sessionStore.close();
        process.exit(0);
    } catch (error) {
        console.error("Greška tokom gašenja servera:", error);
        process.exit(1);
    }
}

process.on("SIGTERM", () => {
    void gracefulShutdown("SIGTERM");
});

process.on("SIGINT", () => {
    void gracefulShutdown("SIGINT");
});
