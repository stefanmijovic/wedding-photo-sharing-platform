import type Database from "better-sqlite3";

export const SQLITE_BUSY_RETRY_AFTER_SECONDS = 2;

export function configureSqliteReliability(db: Database.Database, busyTimeoutMs = 5_000): void {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
}

export function sqliteErrorCode(error: unknown): string | null {
    if (!error || typeof error !== "object" || !("code" in error)) return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
}

export function isTransientSqliteError(error: unknown): boolean {
    const code = sqliteErrorCode(error);
    return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || code?.startsWith("SQLITE_BUSY_") === true;
}

export function safeErrorCode(error: unknown): string {
    if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
        return String((error as { code: string }).code).slice(0, 80);
    }
    return error instanceof Error ? error.name : "UNKNOWN_ERROR";
}

export function logReliabilityError(
    code: string,
    context: Record<string, string | number | null | undefined>,
    error: unknown
): void {
    const safeContext = Object.entries(context)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, " ").slice(0, 120)}`)
        .join(" ");
    console.error(`[${code}]${safeContext ? ` ${safeContext}` : ""} error=${safeErrorCode(error)}`);
}
