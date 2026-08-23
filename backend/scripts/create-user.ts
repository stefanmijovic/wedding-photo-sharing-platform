import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline/promises";
import bcrypt from "bcrypt";
import Database from "better-sqlite3";

dotenv.config();

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const scriptParent = path.dirname(scriptDirectory);
// Source runs from backend/scripts, while compiled production code runs from
// backend/dist/scripts. Both forms must resolve the same backend root.
const backendRoot = path.basename(scriptParent) === "dist"
    ? path.dirname(scriptParent)
    : scriptParent;
const projectRoot = path.dirname(backendRoot);
const args = new Map(
    process.argv.slice(2).map((argument) => {
        const match = /^--([^=]+)=(.*)$/.exec(argument);
        if (!match) throw new Error(`Nepoznat argument: ${argument}`);
        return [match[1]!, match[2]!] as const;
    })
);
const username = args.get("username")?.trim();
const role = args.get("role")?.trim();
if (!username || username.length > 100 || !/^[\p{L}\p{N}_.-]+$/u.test(username)) {
    throw new Error("--username je obavezan i sme sadržati slova, brojeve, _, . i - (najviše 100 karaktera)." );
}
if (role !== "admin" && role !== "couple") {
    throw new Error("--role mora biti admin ili couple.");
}

async function hiddenPrompt(prompt: string): Promise<string> {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
        throw new Error("Kreiranje korisnika zahteva interaktivni terminal; password se ne prihvata kao argument.");
    }
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    return await new Promise((resolve, reject) => {
        let value = "";
        const onData = (key: string) => {
            if (key === "\u0003") {
                cleanup();
                reject(new Error("Prekinuto."));
            } else if (key === "\r" || key === "\n") {
                cleanup();
                process.stdout.write("\n");
                resolve(value);
            } else if (key === "\u007f" || key === "\b") {
                value = value.slice(0, -1);
            } else if (/^[^\u0000-\u001f\u007f]+$/.test(key)) {
                value += key;
            }
        };
        const cleanup = () => {
            process.stdin.off("data", onData);
            process.stdin.setRawMode(false);
            process.stdin.pause();
        };
        process.stdin.on("data", onData);
    });
}

const password = await hiddenPrompt("Password (najmanje 8 karaktera): ");
const repeated = await hiddenPrompt("Ponovi password: ");
if (password.length < 8 || password.length > 200) throw new Error("Password mora imati 8–200 karaktera.");
if (password !== repeated) throw new Error("Password vrednosti se ne poklapaju.");

const dataRoot = process.env.NODE_ENV === "test"
    ? path.resolve(process.env.TEST_DATA_ROOT || "")
    : projectRoot;
if (process.env.NODE_ENV === "test" && !process.env.TEST_DATA_ROOT) throw new Error("TEST_DATA_ROOT je obavezan u test modu.");
const db = new Database(path.join(dataRoot, "database.sqlite"));
try {
    const columns = db.prepare("PRAGMA table_info(admins)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "role")) {
        throw new Error("Pokrenite novu verziju aplikacije jednom da izvrši role migraciju.");
    }
    const existing = db.prepare("SELECT id FROM admins WHERE username = ?").get(username);
    if (existing) {
        const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
        const confirmation = await prompt.question(`Korisnik '${username}' postoji. Upišite TAČNO 'YES' za zamenu passworda i role: `);
        prompt.close();
        if (confirmation !== "YES") throw new Error("Postojeći korisnik nije izmenjen.");
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO admins (username, password_hash, role, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role
    `).run(username, passwordHash, role, now);
    console.log(`Korisnik '${username}' je sačuvan sa role '${role}'.`);
} finally {
    db.close();
}
