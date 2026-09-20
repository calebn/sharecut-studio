import { describe, expect, it, vi } from "vitest";
import {
  descendantPids,
  parseProcessTable,
  processTreeTerminator,
} from "./processTree";

function missingProcess(): NodeJS.ErrnoException {
  return Object.assign(new Error("missing process"), { code: "ESRCH" });
}

describe("processTreeTerminator", () => {
  it("parses the POSIX process table and finds nested descendants", () => {
    const table = parseProcessTable(" 42 1\n 43 42\n44 43\n 45 42\n");
    expect(descendantPids(42, table)).toEqual([43, 45, 44]);
  });

  it("signals detached descendant groups and waits for every process", async () => {
    const alive = new Set([42, 43, 44]);
    const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) {
        if (!alive.has(pid)) {
          throw missingProcess();
        }
        return;
      }
      if (pid > 0) {
        alive.delete(pid);
      }
    });
    const terminator = processTreeTerminator("darwin", {
      kill,
      pause: async () => undefined,
      readProcessTable: () =>
        new Map([
          [42, 1],
          [43, 42],
          [44, 43],
        ]),
    });

    await terminator.terminate(42, "SIGTERM");

    expect(kill).toHaveBeenCalledWith(-44, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(44, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(-43, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(43, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(-42, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(42, "SIGTERM");
    expect(alive).toHaveLength(0);
  });

  it("keeps descendants tracked after the root exits", async () => {
    const alive = new Set([42, 43]);
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const kill = (pid: number, signal: NodeJS.Signals | 0) => {
      signals.push([pid, signal]);
      if (signal === 0) {
        if (!alive.has(pid)) {
          throw missingProcess();
        }
        return;
      }
      if (signal === "SIGTERM" && pid > 0) {
        alive.delete(42);
      }
      if (signal === "SIGKILL" && pid > 0) {
        alive.delete(pid);
      }
    };
    let reads = 0;
    const terminator = processTreeTerminator("linux", {
      kill,
      pause: async () => {
        throw new Error("grace period elapsed");
      },
      readProcessTable: () => {
        reads += 1;
        return reads === 1
          ? new Map([
              [42, 1],
              [43, 42],
            ])
          : new Map();
      },
    });

    await expect(terminator.terminate(42, "SIGTERM")).rejects.toThrow(
      "grace period elapsed",
    );
    await terminator.terminate(42, "SIGKILL");

    expect(signals).toContainEqual([43, "SIGKILL"]);
    expect(alive).toHaveLength(0);
  });

  it("uses taskkill for the complete Windows process tree", async () => {
    const run = vi.fn();
    const terminator = processTreeTerminator("win32", { taskkill: run });
    await terminator.terminate(42, "SIGTERM");
    await terminator.terminate(42, "SIGKILL");
    expect(run).toHaveBeenNthCalledWith(1, "taskkill", ["/pid", "42", "/t"]);
    expect(run).toHaveBeenNthCalledWith(2, "taskkill", [
      "/pid",
      "42",
      "/t",
      "/f",
    ]);
  });
});
