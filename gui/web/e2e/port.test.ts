import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireE2ePortLease,
  configuredE2ePort,
  createPortLease,
  observePortLease,
  reclaimObservedPortLease,
} from "./port";

function temporaryLockDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sharecut-e2e-port-test-"));
}

function lockPath(directory: string, port: number): string {
  return path.join(directory, `sharecut-e2e-port-${port}.lock`);
}

function writeOwner(directory: string, value: string): void {
  fs.writeFileSync(path.join(directory, "owner.json"), value);
}

describe("atomic E2E port leases", () => {
  it("keeps config parsing pure and validates explicit ports", () => {
    expect(configuredE2ePort({})).toBeUndefined();
    expect(configuredE2ePort({ DAW_E2E_PORT: "8777" })).toBe(8777);
    expect(() => configuredE2ePort({ DAW_E2E_PORT: "bad" })).toThrow(
      "must be an integer",
    );
  });

  it("allows only one creator through the atomic publish race", () => {
    const directory = temporaryLockDir();
    let second: ReturnType<typeof createPortLease>;
    const first = createPortLease(8777, directory, "first", () => {
      second = createPortLease(8777, directory, "second");
    });
    expect(first).toBeUndefined();
    expect(second?.port).toBe(8777);
    second?.release();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("leases explicit ports and rejects a live owner", async () => {
    const directory = temporaryLockDir();
    const first = await acquireE2ePortLease(
      { DAW_E2E_PORT: "8778" },
      undefined,
      directory,
    );
    await expect(
      acquireE2ePortLease({ DAW_E2E_PORT: "8778" }, undefined, directory),
    ).rejects.toThrow("already leased");
    first.release();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("reclaims dead and invalid owners as distinct generations", async () => {
    const directory = temporaryLockDir();
    const port = 8779;
    for (const owner of [
      "{bad",
      "",
      JSON.stringify({ pid: 999_999_999, token: "dead" }),
    ]) {
      const current = lockPath(directory, port);
      fs.mkdirSync(current);
      writeOwner(current, owner);
      const lease = await acquireE2ePortLease(
        { DAW_E2E_PORT: String(port) },
        undefined,
        directory,
      );
      lease.release();
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("fences delayed stale observers without displacing a replacement", () => {
    const directory = temporaryLockDir();
    const port = 8780;
    const current = lockPath(directory, port);
    fs.mkdirSync(current);
    writeOwner(current, "{bad");
    const firstObserver = observePortLease(port, directory);
    const delayedObserver = observePortLease(port, directory);
    expect(firstObserver?.generation).toBe(delayedObserver?.generation);
    expect(reclaimObservedPortLease(port, directory, firstObserver)).toBe(true);
    const replacement = createPortLease(port, directory, "replacement");
    expect(replacement?.port).toBe(port);
    expect(reclaimObservedPortLease(port, directory, delayedObserver)).toBe(
      false,
    );
    expect(createPortLease(port, directory, "third")).toBeUndefined();
    expect(
      JSON.parse(fs.readFileSync(path.join(current, "owner.json"), "utf8")),
    ).toEqual({ pid: process.pid, token: "replacement" });
    replacement?.release();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("discards a torn invalid-to-valid observation", () => {
    const directory = temporaryLockDir();
    const port = 8781;
    const current = lockPath(directory, port);
    fs.mkdirSync(current);
    writeOwner(current, "{bad");
    let replacement: ReturnType<typeof createPortLease>;
    const torn = observePortLease(port, directory, () => {
      fs.rmSync(current, { recursive: true, force: true });
      replacement = createPortLease(port, directory, "replacement");
    });
    expect(torn).toBeUndefined();
    expect(replacement?.port).toBe(port);
    expect(reclaimObservedPortLease(port, directory, torn)).toBe(false);
    expect(createPortLease(port, directory, "third")).toBeUndefined();
    replacement?.release();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("owner-checked release cannot remove another token", () => {
    const directory = temporaryLockDir();
    const port = 8782;
    const first = createPortLease(port, directory, "first");
    fs.rmSync(lockPath(directory, port), { recursive: true });
    const replacement = createPortLease(port, directory, "replacement");
    first?.release();
    expect(fs.existsSync(lockPath(directory, port))).toBe(true);
    replacement?.release();
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
