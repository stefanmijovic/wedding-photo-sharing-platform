import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
    activeChildProcessCount,
    registerChildProcess,
    terminateActiveChildProcesses
} from "../dist/child-process-registry.js";

class StubChild extends EventEmitter {
    signals = [];
    constructor(onKill) {
        super();
        this.onKill = onKill;
    }
    kill(signal) {
        this.signals.push(signal);
        this.onKill?.(signal, this);
        return true;
    }
}

test("registry release je idempotent i normalan close uklanja child", () => {
    const child = new StubChild();
    const release = registerChildProcess(child);
    assert.equal(activeChildProcessCount(), 1);
    child.emit("close", 0, null);
    release();
    assert.equal(activeChildProcessCount(), 0);
});

test("bounded cleanup daje TERM grace, zatim KILL child-u koji ostaje živ", async () => {
    const graceful = new StubChild((signal, child) => {
        if (signal === "SIGTERM") setTimeout(() => child.emit("close", 0, "SIGTERM"), 1);
    });
    const stuck = new StubChild((signal, child) => {
        if (signal === "SIGKILL") setTimeout(() => child.emit("close", 0, "SIGKILL"), 1);
    });
    registerChildProcess(graceful);
    registerChildProcess(stuck);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(graceful.signals, []);
    assert.deepEqual(stuck.signals, []);
    const result = await terminateActiveChildProcesses(10, 10);
    assert.deepEqual(result, { terminated: 2, killed: 1, remaining: 0 });
    assert.deepEqual(graceful.signals, ["SIGTERM"]);
    assert.deepEqual(stuck.signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(activeChildProcessCount(), 0);
});
