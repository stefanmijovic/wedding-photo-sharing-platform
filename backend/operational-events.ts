export type OperationalCategory = "image" | "video" | "voice" | "api";

export type OperationalCode =
    | "CAPACITY_TEMPORARILY_UNAVAILABLE"
    | "LOW_DISK_SPACE"
    | "IMAGE_PIPELINE_BUSY"
    | "VIDEO_QUEUE_BUSY"
    | "VOICE_PIPELINE_BUSY"
    | "SERVICE_SHUTTING_DOWN"
    | "DB_TEMPORARILY_BUSY";

export type OperationalEvent = "CAPACITY_REJECTION" | "DB_CONTENTION_REJECTION";

const CATEGORIES = new Set<OperationalCategory>(["image", "video", "voice", "api"]);
const CODES = new Set<OperationalCode>([
    "CAPACITY_TEMPORARILY_UNAVAILABLE",
    "LOW_DISK_SPACE",
    "IMAGE_PIPELINE_BUSY",
    "VIDEO_QUEUE_BUSY",
    "VOICE_PIPELINE_BUSY",
    "SERVICE_SHUTTING_DOWN",
    "DB_TEMPORARILY_BUSY"
]);

interface WindowState {
    startedAt: number;
    suppressed: number;
}

/**
 * Fixed-shape, fixed-window operational rejection logger.
 * It deliberately accepts no request object or arbitrary context.
 */
export class OperationalRejectionLogger {
    private readonly windows = new Map<string, WindowState>();

    constructor(
        private readonly logger: Pick<Console, "warn"> = console,
        private readonly windowMs = 60_000,
        private readonly now: () => number = Date.now
    ) {}

    record(event: OperationalEvent, categoryValue: OperationalCategory | string, codeValue: OperationalCode | string): void {
        const category = CATEGORIES.has(categoryValue as OperationalCategory)
            ? categoryValue as OperationalCategory
            : "api";
        const code = CODES.has(codeValue as OperationalCode)
            ? codeValue as OperationalCode
            : "CAPACITY_TEMPORARILY_UNAVAILABLE";
        const key = `${event}:${category}:${code}`;
        const timestamp = this.now();
        const current = this.windows.get(key);

        if (current && timestamp - current.startedAt < this.windowMs) {
            current.suppressed += 1;
            return;
        }

        const suppressed = current?.suppressed ?? 0;
        this.windows.set(key, { startedAt: timestamp, suppressed: 0 });
        this.logger.warn(`[${event}] category=${category} code=${code} suppressed=${suppressed}`);
    }
}
