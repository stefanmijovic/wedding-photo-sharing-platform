export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 90_000;
export const FORCED_CHILD_TERM_GRACE_MS = 2_000;
export const SHUTDOWN_RETRY_AFTER_SECONDS = 30;

export type LifecycleState = "running" | "shuttingDown";
export type ReadinessDiskState = "healthy" | "warning" | "reject" | "emergency" | "unknown";

export class LifecycleController {
    private stateValue: LifecycleState = "running";
    private shutdownStartedAtValue: number | null = null;
    private activeRequestsValue = 0;
    private readonly requestDrainWaiters = new Set<() => void>();

    constructor(private readonly now: () => number = Date.now) {}

    get state(): LifecycleState { return this.stateValue; }
    get isShuttingDown(): boolean { return this.stateValue === "shuttingDown"; }
    get shutdownStartedAt(): number | null { return this.shutdownStartedAtValue; }
    get activeRequests(): number { return this.activeRequestsValue; }

    beginShutdown(): boolean {
        if (this.isShuttingDown) return false;
        this.stateValue = "shuttingDown";
        this.shutdownStartedAtValue = this.now();
        return true;
    }

    beginRequest(): () => void {
        this.activeRequestsValue += 1;
        let ended = false;
        return () => {
            if (ended) return;
            ended = true;
            this.activeRequestsValue = Math.max(0, this.activeRequestsValue - 1);
            if (this.activeRequestsValue === 0) {
                for (const resolve of this.requestDrainWaiters) resolve();
                this.requestDrainWaiters.clear();
            }
        };
    }

    waitForRequestsToDrain(): Promise<void> {
        if (this.activeRequestsValue === 0) return Promise.resolve();
        return new Promise((resolve) => this.requestDrainWaiters.add(resolve));
    }
}

export function readinessDecision(
    lifecycle: Pick<LifecycleController, "isShuttingDown">,
    diskStates: ReadinessDiskState[]
): { ready: boolean; reason: "ready" | "shutdown" | "capacity" } {
    if (lifecycle.isShuttingDown) return { ready: false, reason: "shutdown" };
    if (diskStates.some((state) => state === "emergency" || state === "unknown")) {
        return { ready: false, reason: "capacity" };
    }
    return { ready: true, reason: "ready" };
}

export async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<{ completed: true; value: T } | { completed: false }> {
    let timer: NodeJS.Timeout | null = null;
    try {
        return await Promise.race([
            promise.then((value) => ({ completed: true as const, value })),
            new Promise<{ completed: false }>((resolve) => {
                timer = setTimeout(() => resolve({ completed: false }), timeoutMs);
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
