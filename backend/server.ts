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
import { createRequire } from "module";      // Omogućava korišćenje CommonJS require() unutar ESM modula
import bcrypt from "bcrypt";                 // Biblioteka za heširanje i proveru lozinki
import session from "express-session";       // Middleware za upravljanje sesijama (login admin panela)
import { ProcessingQueue, migrateProcessingJobs, type ProcessingJob } from "./processing-queue.js";
import {
    hasRecognizedAudioSignature,
    normalizeVoiceToM4a,
    probeAudio,
    validateVoiceMetadata,
    verifyAudioDecodable
} from "./audio-processing.js";
import {
    configureVoiceStorage,
    createPrivateSourceFilename,
    migrateVoiceMessages,
    normalizeSenderName,
    safeDownloadSender
} from "./voice-messages.js";

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
const backendRoot = path.basename(__dirname) === "dist" ? path.dirname(__dirname) : __dirname;
const projectRoot = path.dirname(backendRoot);
const configuredTestDataRoot = process.env.TEST_DATA_ROOT?.trim();

if (process.env.NODE_ENV === "test" && !configuredTestDataRoot) {
    throw new Error("TEST_DATA_ROOT mora biti definisan u test okruženju.");
}

// Testovi koriste potpuno odvojen privremeni data root. U svim ostalim
// okruženjima putanje ostaju identične dosadašnjim produkcionim putanjama.
const dataRoot = process.env.NODE_ENV === "test"
    ? path.resolve(configuredTestDataRoot as string)
    : projectRoot;
const uploadsRoot = path.join(dataRoot, "uploads");

// ============================================================
// INICIJALIZACIJA EXPRESS APLIKACIJE
// ============================================================
const app = express();

app.disable("x-powered-by"); // Bezbednosna mera - ne otkriva se da je backend napisan u Express-u

const configuredPort = process.env.PORT ? Number(process.env.PORT) : 3000;

if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) {
    throw new Error("PORT mora biti ceo broj između 0 i 65535.");
}

const PORT = configuredPort;

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
const COUPLE_NOTIFICATION_EMAIL = process.env.NODE_ENV === "test"
    ? "test-couple@example.invalid"
    : getRequiredEnv("COUPLE_NOTIFICATION_EMAIL");
const COUPLE_PANEL_URL = process.env.NODE_ENV === "test"
    ? "http://localhost/admin.html"
    : getRequiredEnv("COUPLE_PANEL_URL");

function getRequiredDateEnv(name: string): { value: string; timestamp: number } {
    const value = getRequiredEnv(name).trim();

    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
        throw new Error(`${name} mora sadržati eksplicitnu vremensku zonu.`);
    }

    const timestamp = Date.parse(value);

    if (!Number.isFinite(timestamp)) {
        throw new Error(`${name} nije validan ISO 8601 datum.`);
    }

    return { value, timestamp };
}

const eventUnlockConfig = getRequiredDateEnv("EVENT_UNLOCK_AT");
const weddingConfig = getRequiredDateEnv("WEDDING_AT");

if (eventUnlockConfig.timestamp >= weddingConfig.timestamp) {
    throw new Error("EVENT_UNLOCK_AT mora biti pre WEDDING_AT.");
}

const eventConfig = Object.freeze({
    unlockAt: eventUnlockConfig.value,
    weddingAt: weddingConfig.value
});

function isEventUnlocked(now = Date.now()): boolean {
    return now >= eventUnlockConfig.timestamp;
}

function requireEventUnlocked(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) {
    if (!isEventUnlocked()) {
        return res.status(403).json({
            error: "Događaj još nije otključan.",
            code: "EVENT_LOCKED",
            unlockAt: eventConfig.unlockAt
        });
    }

    next();
}

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
    if (process.env.NODE_ENV === "test") {
        return;
    }

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
const configuredOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

if (process.env.NODE_ENV === "production" && configuredOrigins.length === 0) {
    throw new Error("ALLOWED_ORIGINS mora sadržati najmanje jedan production origin.");
}

const allowedOrigins = configuredOrigins.length > 0
    ? configuredOrigins
    : ["http://localhost", "http://localhost:3000"];

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
const sessionDbPath = path.join(dataRoot, "sessions.sqlite");

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

const voiceUploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Previše pokušaja slanja glasovne poruke. Pokušajte kasnije." }
});

// ============================================================
// PUTANJE ZA FAJLOVE I BAZU PODATAKA
// ============================================================
const uploadFolderOriginal = path.join(uploadsRoot, "original");           // Originalne slike
const uploadFolderThumbs = path.join(uploadsRoot, "thumbs");               // Thumbnail-ovi slika
const uploadFolderVideosOriginal = path.join(uploadsRoot, "videos/original"); // Originalni video fajlovi
const uploadFolderVideosThumbs = path.join(uploadsRoot, "videos/thumbs");     // Thumbnail-ovi (frame) videa
const uploadFolderVideosWeb = path.join(uploadsRoot, "videos/web");           // Web-optimizovane verzije videa
const dbPath = path.join(dataRoot, "database.sqlite");                         // Putanja do SQLite baze
const voiceStorage = configureVoiceStorage({
    nodeEnv: process.env.NODE_ENV,
    testDataRoot: configuredTestDataRoot,
    configuredRoot: process.env.VOICE_MESSAGES_DIR,
    uploadsRoot
});

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
migrateProcessingJobs(db);
migrateVoiceMessages(db);

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

const adminColumns = db.prepare("PRAGMA table_info(admins)").all() as { name: string }[];
if (!adminColumns.some((column) => column.name === "role")) {
    db.exec("ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
}
db.prepare("UPDATE admins SET role = 'admin' WHERE role NOT IN ('admin', 'couple') OR role IS NULL").run();

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
app.use("/uploads", express.static(uploadsRoot));

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
    const allowedImageExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"];
    const allowedVideoExtensions = [".mp4", ".mov", ".webm", ".avi", ".mkv"];

    const ext = path.extname(file.originalname).toLowerCase();
    const isHeic = [".heic", ".heif"].includes(ext);

    // iOS/Safari ponekad šalje HEIC kao application/octet-stream, pa se HEIC
    // prihvata po ekstenziji, a stvarni sadržaj zatim validira heif-convert.
    const isImage =
        allowedImageExtensions.includes(ext) &&
        (file.mimetype.startsWith("image/") || isHeic);

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

const voiceStorageEngine = multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, voiceStorage.incoming),
    filename: (_req, _file, callback) => callback(null, createPrivateSourceFilename())
});
const voiceUpload = multer({
    storage: voiceStorageEngine,
    limits: { fileSize: 25 * 1024 * 1024, files: 1 }
});

async function probeUploadedVoice(filePath: string) {
    if (process.env.NODE_ENV === "test" && process.env.TEST_VOICE_PROCESSOR === "stub") {
        const marker = fs.readFileSync(filePath).subarray(4).toString("utf8");
        if (marker.includes("CORRUPT")) throw new Error("Test corrupt audio.");
        if (marker.includes("VIDEO")) throw new Error("Glasovna poruka ne sme sadržati video stream.");
        return {
            durationSeconds: marker.includes("LONG") ? 122 : marker.includes("SHORT") ? 0.5 : 3.25,
            channels: 1,
            sampleRate: 48_000,
            codecName: "opus",
            formatName: "webm",
            sizeBytes: fs.statSync(filePath).size
        };
    }
    return probeAudio(filePath);
}

function sendVoiceNotification(voiceId: number, senderName: string | null, durationSeconds: number): void {
    if (process.env.NODE_ENV === "test") {
        if (process.env.TEST_COUPLE_EMAIL === "success") {
            db.prepare("UPDATE voice_messages SET notification_sent_at = ? WHERE id = ?")
                .run(new Date().toISOString(), voiceId);
        }
        return;
    }
    const subject = "Nova glasovna poruka je stigla ❤️";
    const body = `Nova glasovna poruka je stigla.\n\nPošiljalac: ${senderName || "Anonimno"}\nTrajanje: ${Math.round(durationSeconds)} sekundi\n\nCouple panel:\n${COUPLE_PANEL_URL}\n`;
    const mailProcess = execFile("mail", ["-s", subject, COUPLE_NOTIFICATION_EMAIL], (error) => {
        if (error) {
            console.error("Voice email notifikacija nije poslata:", error);
            return;
        }
        try {
            db.prepare("UPDATE voice_messages SET notification_sent_at = ? WHERE id = ?")
                .run(new Date().toISOString(), voiceId);
        } catch (dbError) {
            console.error("Voice notification_sent_at nije upisan:", dbError);
        }
    });
    mailProcess.stdin?.write(body);
    mailProcess.stdin?.end();
}

// Sharp build na produkcionom serveru nema HEIC/HEIF input podršku.
// Sistemski heif-convert (paket libheif-examples) prvo pretvara HEIC u
// privremeni JPEG, koji zatim prolazi kroz isti Sharp tok kao ostale slike.
function convertHeicToJpeg(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(
            "heif-convert",
            ["-q", "95", inputPath, outputPath],
            {
                timeout: 120_000,
                maxBuffer: 10 * 1024 * 1024
            },
            (error, _stdout, stderr) => {
                if (error) {
                    if ("code" in error && error.code === "ENOENT") {
                        reject(new Error("HEIC podrška nije instalirana na serveru.", { cause: error }));
                        return;
                    }

                    reject(
                        new Error(
                            `Neispravan ili nepodržan HEIC/HEIF fajl: ${stderr.trim() || error.message}`,
                            { cause: error }
                        )
                    );
                    return;
                }

                if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
                    reject(new Error("Neispravan ili nepodržan HEIC/HEIF fajl."));
                    return;
                }

                resolve();
            }
        );
    });
}

// ============================================================
// AI MODERACIJA - RED ČEKANJA (QUEUE) ZA OBRADU SLIKA
// ============================================================
// Ovo garantuje da se AI moderacija slika izvršava JEDNA PO JEDNA (sekvencijalno),
// a ne paralelno za sve upload-ovane slike istovremeno (štedi resurse/API pozive)
let aiJobCounter = 0;
let aiQueue = Promise.resolve(); // "Rep" (tail) promise-a koji predstavlja trenutni kraj reda

function runAiModerationQueued(filePath: string) {
    if (process.env.NODE_ENV === "test" && process.env.TEST_SKIP_AI_MODERATION === "1") {
        return Promise.resolve({
            status: "approved",
            aiScore: 0,
            aiReason: "Test moderation adapter"
        });
    }

    const jobId = ++aiJobCounter; // Jedinstveni ID posla radi logovanja

    console.log("AI queue čeka:", jobId, path.basename(filePath));

    // Novi posao se "kači" na prethodni u nizu - izvršiće se tek kad se prethodni završi
    const job = aiQueue.then(async () => {
        console.log("AI queue počinje:", jobId, path.basename(filePath));

        // Native TensorFlow modul se učitava tek kada stvarna fotografija stigne
        // na obradu; ostale API rute ne plaćaju njegov startup trošak.
        const { moderateImage } = await import("./moderation.js");
        const result = await moderateImage(filePath);

        console.log("AI queue završena:", jobId, path.basename(filePath), result.status, result.aiScore);

        return result;
    });

    // Ažurira "rep" reda na trenutni posao (bez obzira na uspeh/neuspeh - catch hvata grešku da ne blokira red)
    aiQueue = job.then(() => undefined).catch(() => undefined);

    return job;
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

function runFfprobe(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(
            "ffprobe",
            ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", filePath],
            { timeout: 30_000, maxBuffer: 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error || !stdout.trim()) {
                    reject(new Error(`FFprobe nije potvrdio video output: ${stderr.trim() || error?.message || "nema video streama"}`));
                    return;
                }
                resolve();
            }
        );
    });
}

async function validVideoOutputs(thumbPath: string, webPath: string): Promise<boolean> {
    try {
        if (
            !fs.existsSync(thumbPath) || fs.statSync(thumbPath).size === 0 ||
            !fs.existsSync(webPath) || fs.statSync(webPath).size === 0
        ) {
            return false;
        }
        const metadata = await sharp(thumbPath).metadata();
        if (!metadata.width || !metadata.height) return false;
        await runFfprobe(webPath);
        return true;
    } catch {
        return false;
    }
}

// Stvarna obrada videa: generiše thumbnail (jedan frame) i web-optimizovanu verziju,
// pa ažurira bazu sa novim putanjama nakon završetka obrade
async function processVideoJob(job: ProcessingJob) {
    const photo = db.prepare(`
        SELECT id, filename
        FROM photos
        WHERE id = ? AND media_type = 'video'
    `).get(job.targetId) as { id: number; filename: string } | undefined;

    if (!photo) {
        processingQueue.deleteForTarget(job.targetType, job.targetId);
        return;
    }

    const photoId = photo.id;
    const filename = photo.filename;
    const filePath = path.join(uploadFolderVideosOriginal, filename);
    const videoThumbName = filename + ".jpg";
    const videoThumbPath = path.join(uploadFolderVideosThumbs, videoThumbName);

    const webVideoName = `${path.parse(filename).name}.mp4`;
    const webVideoPath = path.join(uploadFolderVideosWeb, webVideoName);
    const videoThumbProcessingPath = `${videoThumbPath}.processing-${job.id}.jpg`;
    const webVideoProcessingPath = `${webVideoPath}.processing-${job.id}.mp4`;

    const thumbUrl = `/uploads/videos/thumbs/${videoThumbName}`;
    const webUrl = `/uploads/videos/web/${webVideoName}`;

    console.log("Pokrećem queued video obradu:", photoId, filename);

    try {
        if (!fs.existsSync(filePath)) {
            throw new Error("Originalni video fajl ne postoji.");
        }

        if (await validVideoOutputs(videoThumbPath, webVideoPath)) {
            db.prepare(`
                UPDATE photos
                SET thumb_url = ?, web_url = ?, ai_reason = ?
                WHERE id = ? AND media_type = 'video'
            `).run(thumbUrl, webUrl, "Video fajl - web verzija spremna, ručni pregled potreban", photoId);
            return;
        }

        for (const invalidOrPartialPath of [
            videoThumbPath,
            webVideoPath,
            videoThumbProcessingPath,
            webVideoProcessingPath
        ]) {
            if (fs.existsSync(invalidOrPartialPath)) fs.unlinkSync(invalidOrPartialPath);
        }

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
            videoThumbProcessingPath
        ];
        const thumbnailExists = () =>
            fs.existsSync(videoThumbProcessingPath) && fs.statSync(videoThumbProcessingPath).size > 0;

        try {
            await runNiceFfmpeg(thumbnailArgs(true));
        } catch (thumbnailError) {
            console.warn("Thumbnail na 1. sekundi nije napravljen, pokušavam prvi frejm:", thumbnailError);
        }

        if (!thumbnailExists()) {
            if (fs.existsSync(videoThumbProcessingPath)) {
                fs.unlinkSync(videoThumbProcessingPath);
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
            webVideoProcessingPath
        ]);

        if (!(await validVideoOutputs(videoThumbProcessingPath, webVideoProcessingPath))) {
            throw new Error("FFmpeg nije napravio validan thumbnail i web MP4.");
        }

        const stillExists = db.prepare(`
            SELECT id
            FROM photos
            WHERE id = ? AND media_type = 'video'
        `).get(photoId);
        const activeJob = db.prepare(`
            SELECT id
            FROM processing_jobs
            WHERE id = ? AND status = 'processing'
        `).get(job.id);

        if (!stillExists || !activeJob) {
            for (const partialPath of [videoThumbProcessingPath, webVideoProcessingPath]) {
                if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
            }
            return;
        }

        fs.renameSync(videoThumbProcessingPath, videoThumbPath);
        fs.renameSync(webVideoProcessingPath, webVideoPath);

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
        for (const generatedPath of [videoThumbProcessingPath, webVideoProcessingPath]) {
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

async function processVoiceJob(job: ProcessingJob): Promise<void> {
    const voice = db.prepare(`
        SELECT id, source_filename AS sourceFilename, filename, sender_name AS senderName
        FROM voice_messages WHERE id = ?
    `).get(job.targetId) as
        | { id: number; sourceFilename: string; filename: string | null; senderName: string | null }
        | undefined;
    if (!voice) {
        processingQueue.deleteForTarget(job.targetType, job.targetId);
        return;
    }
    const sourcePath = path.join(voiceStorage.incoming, path.basename(voice.sourceFilename));
    const finalFilename = `${voice.id}.m4a`;
    const finalPath = path.join(voiceStorage.processed, finalFilename);
    const processingPath = path.join(voiceStorage.processed, `${voice.id}.processing-${job.id}.m4a`);
    try {
        let metadata;
        if (fs.existsSync(finalPath)) {
            metadata = process.env.NODE_ENV === "test" && process.env.TEST_VOICE_PROCESSOR === "stub"
                ? { durationSeconds: 3.25, channels: 1, sampleRate: 48_000, codecName: "aac", formatName: "mov,mp4,m4a", sizeBytes: fs.statSync(finalPath).size }
                : await probeAudio(finalPath);
        } else {
            if (!fs.existsSync(sourcePath)) throw new Error("Originalna glasovna poruka ne postoji.");
            if (fs.existsSync(processingPath)) fs.unlinkSync(processingPath);
            if (process.env.NODE_ENV === "test" && process.env.TEST_VOICE_PROCESSOR === "stub") {
                const delayMs = Number(process.env.TEST_VOICE_PROCESSOR_DELAY_MS) || 0;
                if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
                if (process.env.TEST_VOICE_PROCESSOR_FAILURE === "1") throw new Error("Kontrolisana voice normalization greška.");
                fs.writeFileSync(processingPath, Buffer.from("test-m4a-output"));
                metadata = { durationSeconds: 3.25, channels: 1, sampleRate: 48_000, codecName: "aac", formatName: "mov,mp4,m4a", sizeBytes: fs.statSync(processingPath).size };
            } else {
                await normalizeVoiceToM4a(sourcePath, processingPath);
                metadata = await probeAudio(processingPath);
            }
            validateVoiceMetadata(metadata);
            if (metadata.codecName !== "aac") throw new Error("Normalizovani audio nije AAC.");
            const stillExists = db.prepare("SELECT id FROM voice_messages WHERE id = ?").get(voice.id);
            const activeJob = db.prepare("SELECT id FROM processing_jobs WHERE id = ? AND status = 'processing'").get(job.id);
            if (!stillExists || !activeJob) {
                if (fs.existsSync(processingPath)) fs.unlinkSync(processingPath);
                return;
            }
            fs.renameSync(processingPath, finalPath);
            metadata.sizeBytes = fs.statSync(finalPath).size;
        }
        validateVoiceMetadata(metadata);
        if (metadata.codecName !== "aac") throw new Error("Normalizovani audio nije AAC.");
        const update = db.prepare(`
            UPDATE voice_messages
            SET filename = ?, duration_seconds = ?, size_bytes = ?, mime_type = 'audio/mp4'
            WHERE id = ?
        `).run(finalFilename, metadata.durationSeconds, metadata.sizeBytes, voice.id);
        if (update.changes !== 1) {
            if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
            return;
        }
        if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
        setImmediate(() => sendVoiceNotification(voice.id, voice.senderName, metadata.durationSeconds));
    } catch (error) {
        if (fs.existsSync(processingPath)) {
            try { fs.unlinkSync(processingPath); } catch (cleanupError) {
                console.error("Voice partial output nije očišćen:", cleanupError);
            }
        }
        throw error;
    }
}

const processingQueue = new ProcessingQueue({
    db,
    ...(process.env.NODE_ENV === "test" && process.env.TEST_PROCESSING_RETRY_MS
        ? { retryDelaysMs: process.env.TEST_PROCESSING_RETRY_MS.split(",").map(Number) }
        : {}),
    ...(process.env.NODE_ENV === "test" && process.env.TEST_PROCESSING_STALE_MS
        ? { staleAfterMs: Number(process.env.TEST_PROCESSING_STALE_MS) }
        : {}),
    processors: {
        video_process:
            process.env.NODE_ENV === "test" && process.env.TEST_VIDEO_PROCESSOR === "stub"
                ? async (job) => {
                    const delayMs = Number(process.env.TEST_VIDEO_PROCESSOR_DELAY_MS) || 0;
                    if (delayMs > 0) {
                        await new Promise((resolve) => setTimeout(resolve, delayMs));
                    }
                    const photo = db.prepare(`
                        SELECT id, filename FROM photos
                        WHERE id = ? AND media_type = 'video'
                    `).get(job.targetId) as { id: number; filename: string } | undefined;
                    if (!photo) {
                        processingQueue.deleteForTarget(job.targetType, job.targetId);
                        return;
                    }
                    const thumbName = `${photo.filename}.jpg`;
                    const webName = `${path.parse(photo.filename).name}.mp4`;
                    fs.writeFileSync(path.join(uploadFolderVideosThumbs, thumbName), "test-thumbnail");
                    fs.writeFileSync(path.join(uploadFolderVideosWeb, webName), "test-web-video");
                    db.prepare(`
                        UPDATE photos
                        SET thumb_url = ?, web_url = ?, ai_reason = ?
                        WHERE id = ?
                    `).run(
                        `/uploads/videos/thumbs/${thumbName}`,
                        `/uploads/videos/web/${webName}`,
                        "Video fajl - web verzija spremna, ručni pregled potreban",
                        photo.id
                    );
                }
                : processVideoJob,
        voice_normalize: processVoiceJob
    }
});

function bootstrapLegacyVideoJobs(): void {
    const videos = db.prepare(`
        SELECT id, filename, thumb_url AS thumbUrl, web_url AS webUrl
        FROM photos
        WHERE media_type = 'video' AND status = 'pending_review'
          AND NOT EXISTS (
              SELECT 1 FROM processing_jobs
              WHERE target_type = 'photo'
                AND target_id = photos.id
                AND job_type = 'video_process'
          )
    `).all() as { id: number; filename: string; thumbUrl: string; webUrl: string }[];

    for (const video of videos) {
        const originalPath = path.join(uploadFolderVideosOriginal, video.filename);
        const hasDeclaredOutputs = Boolean(
            video.thumbUrl && video.webUrl &&
            fs.existsSync(path.join(uploadFolderVideosThumbs, path.basename(video.thumbUrl))) &&
            fs.existsSync(path.join(uploadFolderVideosWeb, path.basename(video.webUrl)))
        );
        if (hasDeclaredOutputs) continue;

        if (fs.existsSync(originalPath)) {
            processingQueue.enqueue("photo", video.id, "video_process");
            continue;
        }

        const now = new Date().toISOString();
        db.prepare(`
            INSERT OR IGNORE INTO processing_jobs (
                target_type, target_id, job_type, status, attempt_count,
                max_attempts, available_at, completed_at, last_error, created_at
            ) VALUES ('photo', ?, 'video_process', 'failed', 4, 4, ?, ?, ?, ?)
        `).run(video.id, now, now, "Originalni video fajl ne postoji.", now);
        db.prepare("UPDATE photos SET ai_reason = ? WHERE id = ?")
            .run("Video fajl - obrada nije uspela, original nedostaje", video.id);
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

    const user = db.prepare("SELECT id, username, role FROM admins WHERE id = ?")
        .get(req.session.adminId) as { id: number; username: string; role: string } | undefined;
    if (!user || (user.role !== "admin" && user.role !== "couple")) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    res.locals.authUser = user;
    next();
}

function requireCouple(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (!req.session.adminId) return res.status(401).json({ error: "Unauthorized" });
    const user = db.prepare("SELECT id, username, role FROM admins WHERE id = ?")
        .get(req.session.adminId) as { id: number; username: string; role: string } | undefined;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (user.role !== "couple") return res.status(403).json({ error: "Couple pristup je obavezan." });
    res.locals.authUser = user;
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
app.use("/api/couple", requireTrustedAdminOrigin);

function parsePositiveId(value: string | string[] | undefined): number | null {
    if (typeof value !== "string") {
        return null;
    }
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// ============================================================
// RUTA: GET /api/event-config - javna konfiguracija događaja
// ============================================================
app.get("/api/event-config", (req, res) => {
    res.json(eventConfig);
});

app.post(
    "/api/voice-messages",
    requireEventUnlocked,
    voiceUploadLimiter,
    voiceUpload.single("voice"),
    async (req, res) => {
        const file = req.file;
        if (!file) return res.status(400).json({ error: "Glasovni fajl nije poslat." });
        try {
            const senderName = normalizeSenderName(req.body?.sender_name);
            if (!hasRecognizedAudioSignature(file.path)) throw new Error("Audio potpis nije prepoznat.");
            const metadata = await probeUploadedVoice(file.path);
            validateVoiceMetadata(metadata);
            if (!(process.env.NODE_ENV === "test" && process.env.TEST_VOICE_PROCESSOR === "stub")) {
                await verifyAudioDecodable(file.path);
            }
            const insertVoice = db.transaction(() => {
                const result = db.prepare(`
                    INSERT INTO voice_messages (source_filename, sender_name, created_at)
                    VALUES (?, ?, ?)
                `).run(file.filename, senderName, new Date().toISOString());
                const voiceId = Number(result.lastInsertRowid);
                processingQueue.enqueue("voice_message", voiceId, "voice_normalize");
                return voiceId;
            });
            insertVoice();
            return res.status(202).json({
                success: true,
                status: "processing",
                message: "Glasovna poruka je primljena."
            });
        } catch (error) {
            try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (cleanupError) {
                console.error("Nevažeći voice upload nije očišćen:", cleanupError);
            }
            const internalMessage = error instanceof Error ? error.message : "Nepoznata voice upload greška.";
            console.warn("Voice upload validacija nije uspela:", internalMessage);
            const publicMessage = internalMessage.startsWith("sender_name")
                ? internalMessage
                : "Glasovna poruka nije validna ili podržana.";
            return res.status(422).json({ error: publicMessage });
        }
    }
);

// ============================================================
// RUTA: POST /api/upload - upload slike ili videa
// ============================================================
app.post("/api/upload", requireEventUnlocked, uploadLimiter, upload.single("photo"), async (req, res) => {
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
    let convertedHeicPath: string | null = null;

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
            const isHeic = [".heic", ".heif"].includes(ext);
            let sharpInputPath = file.path;

            if (isHeic) {
                convertedHeicPath = `${file.path}.converted.jpg`;
                await convertHeicToJpeg(file.path, convertedHeicPath);
                sharpInputPath = convertedHeicPath;
            }

            // Ispravlja orijentaciju slike (EXIF rotate) i re-enkodira u JPEG visokog kvaliteta
            await sharp(sharpInputPath)
                .rotate()
                .jpeg({ quality: 95 })
                .toFile(processedImagePath);

            fs.unlinkSync(file.path);
            if (convertedHeicPath && fs.existsSync(convertedHeicPath)) {
                fs.unlinkSync(convertedHeicPath);
                convertedHeicPath = null;
            }
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
        const insertMedia = db.transaction(() => {
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
            if (isVideo) {
                processingQueue.enqueue("photo", insertedId, "video_process");
            }
            return insertedId;
        });

        const insertedId = insertMedia();

        // Ako fajl čeka pregled, šalje email obaveštenje administratoru
        if (status === "pending_review") {
            sendPendingReviewEmail(insertedId, storedFilename);
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
            convertedHeicPath,
            storedFilePath,
            storedFilePath + ".processing",
            path.join(uploadFolderThumbs, storedFilename)
        ];

        for (const cleanupPath of cleanupPaths) {
            try {
                if (cleanupPath && fs.existsSync(cleanupPath)) {
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
            errorMessage.includes("corrupt") ||
            errorMessage.includes("neispravan ili nepodržan heic/heif");

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
app.get("/api/photos", requireEventUnlocked, (req, res) => {
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
    const user = res.locals.authUser as { id: number; username: string; role: string };
    res.json({
        id: user.id,
        username: user.username,
        role: user.role
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
            photos.id,
            photos.filename,
            photos.original_url AS originalUrl,
            photos.thumb_url AS thumbUrl,
            photos.status,
            photos.uploaded_at AS uploadedAt,
            photos.views,
            photos.downloads,
            photos.likes,
            photos.ai_score AS aiScore,
            photos.ai_reason AS aiReason,
	    photos.media_type AS mediaType,
	    photos.web_url AS webUrl,
            COALESCE(
                processing_jobs.status,
                CASE
                    WHEN photos.media_type = 'video' AND photos.thumb_url <> '' AND photos.web_url <> '' THEN 'completed'
                    WHEN photos.media_type = 'video' THEN 'queued'
                    ELSE NULL
                END
            ) AS processingStatus,
            processing_jobs.attempt_count AS processingAttempts,
            processing_jobs.max_attempts AS processingMaxAttempts,
            processing_jobs.last_error AS processingError
        FROM photos
        LEFT JOIN processing_jobs
          ON processing_jobs.target_type = 'photo'
         AND processing_jobs.target_id = photos.id
         AND processing_jobs.job_type = 'video_process'
        ORDER BY
            CASE
                WHEN photos.status = 'pending_review' THEN 0
                WHEN photos.status = 'approved' THEN 1
                WHEN photos.status = 'hidden' THEN 2
                ELSE 3
            END,
            photos.uploaded_at DESC
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
                web_url AS webUrl,
                (
                    SELECT status FROM processing_jobs
                    WHERE target_type = 'photo'
                      AND target_id = photos.id
                      AND job_type = 'video_process'
                ) AS processingStatus
            FROM photos
            WHERE id = ?
        `)
        .get(id) as
        | {
              id: number;
              mediaType: string;
              thumbUrl: string;
              webUrl: string;
              processingStatus: string | null;
          }
        | undefined;

    if (!photo) {
        return res.status(404).json({
            error: "Fajl nije pronađen."
        });
    }

    if (
        photo.mediaType === "video" &&
        (!photo.thumbUrl || !photo.webUrl || (photo.processingStatus && photo.processingStatus !== "completed"))
    ) {
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
// RUTA: POST /api/admin/photos/:id/retry-processing
// ============================================================
app.post("/api/admin/photos/:id/retry-processing", requireAdmin, (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (id === null) {
        return res.status(400).json({ error: "Neispravan ID." });
    }

    const video = db.prepare(`
        SELECT id
        FROM photos
        WHERE id = ? AND media_type = 'video'
    `).get(id);
    if (!video) {
        return res.status(404).json({ error: "Video nije pronađen." });
    }

    if (!processingQueue.retryFailed("photo", id, "video_process")) {
        return res.status(409).json({ error: "Samo neuspešna video obrada može ponovo da se pokrene." });
    }

    db.prepare("UPDATE photos SET ai_reason = ? WHERE id = ?")
        .run("Video fajl - obrada ponovo zakazana, ručni pregled potreban", id);
    res.json({ id, processingStatus: "queued" });
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
            processingQueue.deleteForTarget("photo", photoId);
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
        zlib: { level: 0 } // JPEG/MP4 su već kompresovani; bez nepotrebnog CPU opterećenja
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
        zlib: { level: 0 }
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

const voiceStatusSql = `CASE processing_jobs.status
    WHEN 'completed' THEN 'ready'
    WHEN 'processing' THEN 'processing'
    WHEN 'failed' THEN 'failed'
    ELSE 'queued' END`;

app.get("/api/couple/voice-messages", requireCouple, (req, res) => {
    const requestedLimit = Number(req.query.limit ?? 50);
    const requestedOffset = Number(req.query.offset ?? 0);
    const limit = Number.isSafeInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
    const offset = Number.isSafeInteger(requestedOffset) ? Math.max(requestedOffset, 0) : 0;
    const messages = db.prepare(`
        SELECT voice_messages.id, voice_messages.sender_name AS senderName,
               voice_messages.duration_seconds AS durationSeconds,
               voice_messages.created_at AS createdAt,
               voice_messages.listened_at AS listenedAt,
               ${voiceStatusSql} AS processingStatus
        FROM voice_messages
        LEFT JOIN processing_jobs ON processing_jobs.target_type = 'voice_message'
            AND processing_jobs.target_id = voice_messages.id
            AND processing_jobs.job_type = 'voice_normalize'
        ORDER BY voice_messages.created_at DESC, voice_messages.id DESC
        LIMIT ? OFFSET ?
    `).all(limit, offset);
    const total = Number((db.prepare("SELECT COUNT(*) AS total FROM voice_messages").get() as { total: number }).total);
    res.json({ messages, pagination: { total, limit, offset } });
});

app.get("/api/couple/voice-messages/stats", requireCouple, (_req, res) => {
    const stats = db.prepare(`
        SELECT COUNT(*) AS total,
            SUM(CASE WHEN voice_messages.listened_at IS NULL AND processing_jobs.status = 'completed' THEN 1 ELSE 0 END) AS new,
            SUM(CASE WHEN processing_jobs.status = 'completed' THEN 1 ELSE 0 END) AS ready,
            SUM(CASE WHEN processing_jobs.status IN ('queued', 'processing') THEN 1 ELSE 0 END) AS processing,
            SUM(CASE WHEN processing_jobs.status = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM voice_messages
        LEFT JOIN processing_jobs ON processing_jobs.target_type = 'voice_message'
            AND processing_jobs.target_id = voice_messages.id
            AND processing_jobs.job_type = 'voice_normalize'
    `).get();
    res.json({ stats });
});

function getReadyVoice(id: number) {
    return db.prepare(`
        SELECT voice_messages.id, voice_messages.filename,
               voice_messages.sender_name AS senderName,
               voice_messages.created_at AS createdAt,
               voice_messages.mime_type AS mimeType
        FROM voice_messages
        JOIN processing_jobs ON processing_jobs.target_type = 'voice_message'
            AND processing_jobs.target_id = voice_messages.id
            AND processing_jobs.job_type = 'voice_normalize'
            AND processing_jobs.status = 'completed'
        WHERE voice_messages.id = ? AND voice_messages.filename IS NOT NULL
    `).get(id) as { id: number; filename: string; senderName: string | null; createdAt: string; mimeType: string | null } | undefined;
}

app.get("/api/couple/voice-messages/download", requireCouple, (_req, res) => {
    const messages = db.prepare(`
        SELECT voice_messages.id, voice_messages.filename,
               voice_messages.sender_name AS senderName, voice_messages.created_at AS createdAt
        FROM voice_messages
        JOIN processing_jobs ON processing_jobs.target_type = 'voice_message'
            AND processing_jobs.target_id = voice_messages.id
            AND processing_jobs.job_type = 'voice_normalize'
            AND processing_jobs.status = 'completed'
        WHERE voice_messages.filename IS NOT NULL
        ORDER BY voice_messages.created_at ASC, voice_messages.id ASC
    `).all() as { id: number; filename: string; senderName: string | null; createdAt: string }[];
    res.setHeader("Content-Disposition", "attachment; filename=voice-messages.zip");
    res.setHeader("Content-Type", "application/zip");
    const archive = new archiver.ZipArchive({ zlib: { level: 0 } });
    archive.on("warning", (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") archive.emit("error", error);
    });
    archive.on("error", (error: Error) => {
        console.error("Voice ZIP greška:", error);
        res.destroy(error);
    });
    res.on("close", () => { if (!res.writableEnded) archive.abort(); });
    archive.pipe(res);
    for (const message of messages) {
        const filePath = path.join(voiceStorage.processed, path.basename(message.filename));
        if (!fs.existsSync(filePath)) continue;
        const date = new Date(message.createdAt);
        const stamp = Number.isFinite(date.getTime())
            ? date.toISOString().slice(0, 16).replace("T", "_").replace(":", "-")
            : "unknown-date";
        archive.file(filePath, { name: `${stamp}_${safeDownloadSender(message.senderName)}_${message.id}.m4a` });
    }
    void archive.finalize().catch((error: Error) => res.destroy(error));
});

app.get("/api/couple/voice-messages/:id/stream", requireCouple, (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Neispravan ID." });
    const voice = getReadyVoice(id);
    if (!voice) return res.status(404).json({ error: "Glasovna poruka nije spremna." });
    const filePath = path.join(voiceStorage.processed, path.basename(voice.filename));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Audio fajl ne postoji." });
    const size = fs.statSync(filePath).size;
    res.setHeader("Content-Type", "audio/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, no-store");
    const range = req.get("range");
    if (!range) {
        res.setHeader("Content-Length", size);
        fs.createReadStream(filePath).pipe(res);
        return;
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
        res.setHeader("Content-Range", `bytes */${size}`);
        return res.status(416).end();
    }
    let start = match[1] ? Number(match[1]) : NaN;
    let end = match[2] ? Number(match[2]) : size - 1;
    if (!match[1] && match[2]) {
        const suffix = Number(match[2]);
        start = Math.max(0, size - suffix);
        end = size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
        res.setHeader("Content-Range", `bytes */${size}`);
        return res.status(416).end();
    }
    end = Math.min(end, size - 1);
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", end - start + 1);
    fs.createReadStream(filePath, { start, end }).pipe(res);
});

app.get("/api/couple/voice-messages/:id/download", requireCouple, (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Neispravan ID." });
    const voice = getReadyVoice(id);
    if (!voice) return res.status(404).json({ error: "Glasovna poruka nije spremna." });
    const filePath = path.join(voiceStorage.processed, path.basename(voice.filename));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Audio fajl ne postoji." });
    const date = new Date(voice.createdAt).toISOString().slice(0, 10);
    res.download(filePath, `${date}_${safeDownloadSender(voice.senderName)}_${voice.id}.m4a`);
});

app.patch("/api/couple/voice-messages/:id/listened", requireCouple, (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (id === null || typeof req.body?.listened !== "boolean") return res.status(400).json({ error: "Neispravan zahtev." });
    const listenedAt = req.body.listened ? new Date().toISOString() : null;
    const result = db.prepare("UPDATE voice_messages SET listened_at = ? WHERE id = ?").run(listenedAt, id);
    if (result.changes !== 1) return res.status(404).json({ error: "Glasovna poruka nije pronađena." });
    res.json({ id, listenedAt });
});

app.delete("/api/couple/voice-messages/:id", requireCouple, (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Neispravan ID." });
    const voice = db.prepare("SELECT source_filename AS sourceFilename, filename FROM voice_messages WHERE id = ?")
        .get(id) as { sourceFilename: string; filename: string | null } | undefined;
    if (!voice) return res.status(404).json({ error: "Glasovna poruka nije pronađena." });
    const candidates = [
        path.join(voiceStorage.incoming, path.basename(voice.sourceFilename)),
        ...(voice.filename ? [path.join(voiceStorage.processed, path.basename(voice.filename))] : []),
        ...fs.readdirSync(voiceStorage.processed)
            .filter((name) => name.startsWith(`${id}.processing-`))
            .map((name) => path.join(voiceStorage.processed, name))
    ];
    const staged: { original: string; staged: string }[] = [];
    try {
        for (const original of candidates) {
            if (!fs.existsSync(original)) continue;
            const stagedPath = `${original}.deleting-${Date.now()}`;
            fs.renameSync(original, stagedPath);
            staged.push({ original, staged: stagedPath });
        }
        db.transaction(() => {
            processingQueue.deleteForTarget("voice_message", id);
            db.prepare("DELETE FROM voice_messages WHERE id = ?").run(id);
        })();
        for (const file of staged) {
            try {
                if (fs.existsSync(file.staged)) fs.unlinkSync(file.staged);
            } catch (cleanupError) {
                console.error("Obrisani voice fajl nije fizički očišćen:", cleanupError);
            }
        }
        res.json({ id, success: true });
    } catch (error) {
        for (const file of staged.reverse()) {
            if (fs.existsSync(file.staged) && !fs.existsSync(file.original)) fs.renameSync(file.staged, file.original);
        }
        console.error("Voice delete greška:", error);
        res.status(500).json({ error: "Brisanje glasovne poruke nije uspelo." });
    }
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
                error: req.path === "/api/voice-messages"
                    ? "Glasovna poruka je prevelika. Maksimalna veličina je 25 MB."
                    : "Fajl je prevelik. Maksimalna veličina je 500 MB."
            });
        }

        if (err.code === "LIMIT_UNEXPECTED_FILE") {
            return res.status(400).json({
                error: req.path === "/api/voice-messages"
                    ? "Pošaljite tačno jedan fajl u polju 'voice'."
                    : "Neočekivano upload polje. Koristi polje 'photo'."
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
bootstrapLegacyVideoJobs();
if (!(process.env.NODE_ENV === "test" && process.env.TEST_DISABLE_PROCESSING_WORKER === "1")) {
    processingQueue.start();
}

const server = app.listen(PORT, "127.0.0.1", () => {
    const address = server.address();
    const activePort = typeof address === "object" && address ? address.port : PORT;
    console.log(`Server radi na portu ${activePort}`);
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

        await processingQueue.stop();
        await Promise.allSettled([aiQueue]);
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
