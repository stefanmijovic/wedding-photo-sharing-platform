import fs from "fs";
import path from "path";
import crypto from "crypto";
import type Database from "better-sqlite3";

export interface VoiceStorage {
    root: string;
    incoming: string;
    processed: string;
}
export function migrateVoiceMessages(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS voice_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_filename TEXT NOT NULL UNIQUE,
            filename TEXT UNIQUE,
            sender_name TEXT,
            duration_seconds REAL,
            size_bytes INTEGER,
            mime_type TEXT,
            created_at TEXT NOT NULL,
            listened_at TEXT,
            notification_sent_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_voice_messages_created_at
            ON voice_messages(created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_voice_messages_listened_at
            ON voice_messages(listened_at);
    `);
}

function ensureWritableDirectory(directory: string): void {
    fs.mkdirSync(directory, { recursive: true });
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
}

export function configureVoiceStorage(options: {
    nodeEnv: string | undefined;
    testDataRoot: string | undefined;
    configuredRoot: string | undefined;
    uploadsRoot: string;
}): VoiceStorage {
    let root: string;
    if (options.nodeEnv === "test") {
        if (!options.testDataRoot) throw new Error("TEST_DATA_ROOT je obavezan za voice test storage.");
        root = path.resolve(options.testDataRoot, "private", "voice-messages");
    } else {
        const configured = options.configuredRoot?.trim();
        if (!configured || !path.isAbsolute(configured)) {
            throw new Error("VOICE_MESSAGES_DIR mora biti definisana apsolutna putanja.");
        }
        root = path.resolve(configured);
        const uploads = path.resolve(options.uploadsRoot);
        const relative = path.relative(uploads, root);
        if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
            throw new Error("VOICE_MESSAGES_DIR ne sme biti unutar javnog uploads direktorijuma.");
        }
    }
    const incoming = path.join(root, "incoming");
    const processed = path.join(root, "processed");
    ensureWritableDirectory(incoming);
    ensureWritableDirectory(processed);
    return { root, incoming, processed };
}

export function createPrivateSourceFilename(): string {
    return `${Date.now()}-${crypto.randomBytes(16).toString("hex")}.incoming`;
}

export function normalizeSenderName(value: unknown): string | null {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") throw new Error("sender_name mora biti tekst.");
    const normalized = value.normalize("NFC").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
    if (!normalized) return null;
    if ([...normalized].length > 60) throw new Error("sender_name može imati najviše 60 karaktera.");
    return normalized;
}

export function safeDownloadSender(value: string | null): string {
    const normalized = (value || "Anonimno").normalize("NFKC");
    const safe = normalized
        .replace(/[\\/]/g, "-")
        .replace(/\.\.+/g, "-")
        .replace(/[^\p{L}\p{N} _-]+/gu, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 50);
    return safe || "Anonimno";
}
