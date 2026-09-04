import { statfs } from "node:fs/promises";

export const GiB = 1024 ** 3;

export const CAPACITY_POLICY = Object.freeze({
    warningPercent: 20,
    warningBytes: 40 * GiB,
    rejectPercent: 12,
    rejectBytes: 25 * GiB,
    emergencyPercent: 7,
    emergencyBytes: 12 * GiB,
    cacheMs: 3_000,
    retryAfterSeconds: 180,
    imageReservationBytes: 256 * 1024 ** 2,
    videoUploadReservationBytes: 2.5 * GiB,
    videoProcessingReservationBytes: 2 * GiB,
    voiceReservationBytes: 128 * 1024 ** 2,
    maxActiveImages: 2,
    maxPendingImages: 6,
    maxActiveVideos: 2,
    maxActiveVoices: 4,
    videoQueueWarningDepth: 10,
    videoQueueRejectDepth: 20,
    videoQueueWarningAgeMs: 30 * 60_000,
    videoQueueRejectAgeMs: 2 * 60 * 60_000
});

export type DiskState = "healthy" | "warning" | "reject" | "emergency" | "unknown";
export type MediaAdmissionType = "image" | "video" | "voice";

export interface DiskCapacity {
    totalBytes: number;
    availableBytes: number;
    freePercent: number;
    state: DiskState;
    checkedAt: number;
}

export interface VideoQueueStats {
    queued: number;
    processing: number;
    failed: number;
    oldestQueuedAgeMs: number | null;
}

export interface CapacityErrorShape {
    status: 503;
    code: "CAPACITY_TEMPORARILY_UNAVAILABLE" | "LOW_DISK_SPACE" | "IMAGE_PIPELINE_BUSY" | "VIDEO_QUEUE_BUSY" | "VOICE_PIPELINE_BUSY";
    retryAfterSeconds: number;
}

export class CapacityAdmissionError extends Error implements CapacityErrorShape {
    readonly status = 503 as const;
    readonly retryAfterSeconds: number;

    constructor(
        public readonly code: CapacityErrorShape["code"],
        message: string,
        retryAfterSeconds = CAPACITY_POLICY.retryAfterSeconds
    ) {
        super(message);
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

export function classifyDiskState(totalBytes: number, availableBytes: number): DiskState {
    if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(availableBytes) || availableBytes < 0) {
        return "unknown";
    }
    const freePercent = (availableBytes / totalBytes) * 100;
    if (freePercent < CAPACITY_POLICY.emergencyPercent || availableBytes < CAPACITY_POLICY.emergencyBytes) return "emergency";
    if (freePercent < CAPACITY_POLICY.rejectPercent || availableBytes < CAPACITY_POLICY.rejectBytes) return "reject";
    if (freePercent < CAPACITY_POLICY.warningPercent || availableBytes < CAPACITY_POLICY.warningBytes) return "warning";
    return "healthy";
}

export class DiskCapacityProvider {
    private cached: DiskCapacity | null = null;
    private inFlight: Promise<DiskCapacity> | null = null;

    constructor(
        private readonly storagePath: string,
        private readonly statfsFn: typeof statfs = statfs,
        private readonly cacheMs = CAPACITY_POLICY.cacheMs,
        private readonly now: () => number = Date.now
    ) {}

    async get(force = false): Promise<DiskCapacity> {
        const now = this.now();
        if (!force && this.cached && now - this.cached.checkedAt < this.cacheMs) return this.cached;
        if (!force && this.inFlight) return this.inFlight;
        this.inFlight = this.read(now).finally(() => { this.inFlight = null; });
        return this.inFlight;
    }

    private async read(checkedAt: number): Promise<DiskCapacity> {
        try {
            const stats = await this.statfsFn(this.storagePath, { bigint: true });
            const blockSize = Number(stats.bsize);
            const totalBytes = Number(stats.blocks) * blockSize;
            const availableBytes = Number(stats.bavail) * blockSize;
            const result: DiskCapacity = {
                totalBytes,
                availableBytes,
                freePercent: totalBytes > 0 ? (availableBytes / totalBytes) * 100 : 0,
                state: classifyDiskState(totalBytes, availableBytes),
                checkedAt
            };
            this.cached = result;
            return result;
        } catch {
            const result: DiskCapacity = { totalBytes: 0, availableBytes: 0, freePercent: 0, state: "unknown", checkedAt };
            this.cached = result;
            return result;
        }
    }
}

type Release = () => void;
interface PendingImage { resolve: (release: Release) => void; reject: (error: Error) => void; signal?: AbortSignal; abort?: () => void; }

export class AdmissionController {
    private activeImageUploads = 0;
    private activeVideoUploads = 0;
    private activeVoiceUploads = 0;
    private readonly reservedByFilesystem = new Map<Pick<DiskCapacityProvider, "get">, number>();
    private readonly pendingImages: PendingImage[] = [];
    private lastDiskState: DiskState | null = null;
    private queueWarningActive = false;

    constructor(
        private readonly disk: Pick<DiskCapacityProvider, "get"> | ((type: MediaAdmissionType) => Pick<DiskCapacityProvider, "get">),
        private readonly videoStats: () => VideoQueueStats,
        private readonly logger: Pick<Console, "warn" | "info"> = console
    ) {}

    snapshot() {
        return {
            activeImageUploads: this.activeImageUploads,
            pendingImageUploads: this.pendingImages.length,
            activeVideoUploads: this.activeVideoUploads,
            activeVoiceUploads: this.activeVoiceUploads,
            reservedDiskBytes: [...this.reservedByFilesystem.values()].reduce((sum, value) => sum + value, 0)
        };
    }

    async acquire(type: MediaAdmissionType, signal?: AbortSignal): Promise<Release> {
        const reservation = this.reservationFor(type);
        await this.assertDiskCapacity(type, reservation);
        if (type === "video") this.assertVideoQueue();

        if (type === "image" && this.activeImageUploads >= CAPACITY_POLICY.maxActiveImages) {
            if (this.pendingImages.length >= CAPACITY_POLICY.maxPendingImages) {
                throw new CapacityAdmissionError("IMAGE_PIPELINE_BUSY", "Image pipeline je privremeno zauzet.");
            }
            this.addReservation(type, reservation);
            return new Promise<Release>((resolve, reject) => {
                const pending: PendingImage = { resolve, reject, ...(signal ? { signal } : {}) };
                if (signal) {
                    pending.abort = () => {
                        const index = this.pendingImages.indexOf(pending);
                        if (index >= 0) {
                            this.pendingImages.splice(index, 1);
                            this.addReservation(type, -reservation);
                            reject(new CapacityAdmissionError("CAPACITY_TEMPORARILY_UNAVAILABLE", "Upload zahtev je prekinut."));
                        }
                    };
                    if (signal.aborted) return pending.abort();
                    signal.addEventListener("abort", pending.abort, { once: true });
                }
                this.pendingImages.push(pending);
            });
        }

        const current = type === "video" ? this.activeVideoUploads : type === "voice" ? this.activeVoiceUploads : this.activeImageUploads;
        const maximum = type === "video" ? CAPACITY_POLICY.maxActiveVideos : type === "voice" ? CAPACITY_POLICY.maxActiveVoices : CAPACITY_POLICY.maxActiveImages;
        if (current >= maximum) {
            throw new CapacityAdmissionError(
                type === "video" ? "VIDEO_QUEUE_BUSY" : "VOICE_PIPELINE_BUSY",
                `${type} upload pipeline je privremeno zauzet.`
            );
        }
        return this.activate(type, reservation, false);
    }

    private activate(type: MediaAdmissionType, reservation: number, alreadyReserved: boolean): Release {
        if (type === "image") this.activeImageUploads += 1;
        else if (type === "video") this.activeVideoUploads += 1;
        else this.activeVoiceUploads += 1;
        if (!alreadyReserved) this.addReservation(type, reservation);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (type === "image") this.activeImageUploads = Math.max(0, this.activeImageUploads - 1);
            else if (type === "video") this.activeVideoUploads = Math.max(0, this.activeVideoUploads - 1);
            else this.activeVoiceUploads = Math.max(0, this.activeVoiceUploads - 1);
            this.addReservation(type, -reservation);
            if (type === "image") this.promoteImage();
        };
    }

    private promoteImage(): void {
        const pending = this.pendingImages.shift();
        if (!pending) return;
        if (pending.abort && pending.signal) pending.signal.removeEventListener("abort", pending.abort);
        pending.resolve(this.activate("image", CAPACITY_POLICY.imageReservationBytes, true));
    }

    private reservationFor(type: MediaAdmissionType): number {
        if (type === "image") return CAPACITY_POLICY.imageReservationBytes;
        if (type === "voice") return CAPACITY_POLICY.voiceReservationBytes;
        return CAPACITY_POLICY.videoUploadReservationBytes + CAPACITY_POLICY.videoProcessingReservationBytes;
    }

    private providerFor(type: MediaAdmissionType): Pick<DiskCapacityProvider, "get"> {
        return typeof this.disk === "function" ? this.disk(type) : this.disk;
    }

    private addReservation(type: MediaAdmissionType, delta: number): void {
        const provider = this.providerFor(type);
        const next = Math.max(0, (this.reservedByFilesystem.get(provider) ?? 0) + delta);
        if (next === 0) this.reservedByFilesystem.delete(provider);
        else this.reservedByFilesystem.set(provider, next);
    }

    private async assertDiskCapacity(type: MediaAdmissionType, newReservation: number): Promise<void> {
        const provider = this.providerFor(type);
        const capacity = await provider.get();
        if (capacity.state !== this.lastDiskState) {
            if (capacity.state !== "healthy") this.logger.warn(`Capacity: disk state ${capacity.state}`);
            else if (this.lastDiskState) this.logger.info("Capacity: disk state healthy");
            this.lastDiskState = capacity.state;
        }
        if (capacity.state === "unknown") {
            throw new CapacityAdmissionError("CAPACITY_TEMPORARILY_UNAVAILABLE", "Kapacitet skladišta trenutno nije moguće potvrditi.");
        }
        if (capacity.state === "reject" || capacity.state === "emergency") {
            throw new CapacityAdmissionError("LOW_DISK_SPACE", "Nema dovoljno bezbednog prostora za novi upload.");
        }
        const afterReservation = capacity.availableBytes - (this.reservedByFilesystem.get(provider) ?? 0) - newReservation;
        if (classifyDiskState(capacity.totalBytes, afterReservation) === "reject" || classifyDiskState(capacity.totalBytes, afterReservation) === "emergency") {
            throw new CapacityAdmissionError("LOW_DISK_SPACE", "Nema dovoljno rezervisanog prostora za novi upload.");
        }
    }

    private assertVideoQueue(): void {
        const stats = this.videoStats();
        const warning = stats.queued >= CAPACITY_POLICY.videoQueueWarningDepth ||
            (stats.oldestQueuedAgeMs !== null && stats.oldestQueuedAgeMs >= CAPACITY_POLICY.videoQueueWarningAgeMs);
        if (warning && !this.queueWarningActive) this.logger.warn("Capacity: video queue warning threshold reached");
        if (!warning && this.queueWarningActive) this.logger.info("Capacity: video queue pressure normalized");
        this.queueWarningActive = warning;
        if (stats.queued >= CAPACITY_POLICY.videoQueueRejectDepth ||
            (stats.oldestQueuedAgeMs !== null && stats.oldestQueuedAgeMs > CAPACITY_POLICY.videoQueueRejectAgeMs)) {
            throw new CapacityAdmissionError("VIDEO_QUEUE_BUSY", "Video red je privremeno popunjen.");
        }
    }
}
