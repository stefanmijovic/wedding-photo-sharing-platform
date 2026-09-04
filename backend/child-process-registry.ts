import type { ChildProcess } from "node:child_process";

type ManagedChild = Pick<ChildProcess, "kill" | "once">;

const activeChildren = new Set<ManagedChild>();

export function registerChildProcess(child: ManagedChild): () => void {
    activeChildren.add(child);
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        activeChildren.delete(child);
    };
    child.once("close", release);
    child.once("error", release);
    return release;
}

export function activeChildProcessCount(): number {
    return activeChildren.size;
}

async function waitForChildren(children: ManagedChild[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (children.some((child) => activeChildren.has(child)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
    }
}

export async function terminateActiveChildProcesses(
    termGraceMs = 2_000,
    killWaitMs = 250
): Promise<{ terminated: number; killed: number; remaining: number }> {
    const children = [...activeChildren];
    for (const child of children) child.kill("SIGTERM");
    await waitForChildren(children, termGraceMs);
    const remainingAfterTerm = children.filter((child) => activeChildren.has(child));
    for (const child of remainingAfterTerm) child.kill("SIGKILL");
    await waitForChildren(remainingAfterTerm, killWaitMs);
    return {
        terminated: children.length,
        killed: remainingAfterTerm.length,
        remaining: remainingAfterTerm.filter((child) => activeChildren.has(child)).length
    };
}
