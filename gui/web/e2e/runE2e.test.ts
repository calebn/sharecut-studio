import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createE2eCleanupManifest,
  registerE2eCleanupWorkspace,
} from "./cleanupManifest";
import { exitCode, runE2e, type SignalLifecycle } from "./runE2e";

function lease(port = 43_210) {
  return { port, release: vi.fn() };
}

describe("runE2e", () => {
  it("maps child signal exits to conventional shell statuses", () => {
    expect(exitCode(null, "SIGINT")).toBe(130);
    expect(exitCode(null, "SIGTERM")).toBe(143);
    expect(exitCode(null, "SIGKILL")).toBe(137);
    expect(exitCode(null, "SIGHUP")).toBe(1);
  });

  it("forwards arguments, preserves exit code, and cleans after exit", async () => {
    const manifest = createE2eCleanupManifest();
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "sharecut-e2e-test-"),
    );
    const heldLease = lease();
    const code = await runE2e(
      ["--grep", "presence"],
      (args, env) => {
        expect(args).toEqual(["--grep", "presence"]);
        expect(env.DAW_E2E_CLEANUP_MANIFEST).toBe(manifest.manifestPath);
        expect(env.DAW_E2E_PORT).toBe("43210");
        expect(
          registerE2eCleanupWorkspace(workspace, env.DAW_E2E_CLEANUP_MANIFEST),
        ).toBe(true);
        return {
          exited: Promise.resolve(23),
          forceKill: vi.fn(),
          signal: vi.fn(),
        };
      },
      () => manifest,
      async () => heldLease,
    );
    expect(code).toBe(23);
    expect(fs.existsSync(workspace)).toBe(false);
    expect(fs.existsSync(manifest.manifestDir)).toBe(false);
    expect(heldLease.release).toHaveBeenCalledOnce();
  });

  it("cleans the manifest if port leasing fails", async () => {
    const manifest = createE2eCleanupManifest();
    await expect(
      runE2e(
        [],
        () => {
          throw new Error("must not start");
        },
        () => manifest,
        async () => {
          throw new Error("lease failed");
        },
      ),
    ).rejects.toThrow("lease failed");
    expect(fs.existsSync(manifest.manifestDir)).toBe(false);
  });

  it("forwards SIGTERM and force-kills after the grace period", async () => {
    const manifest = createE2eCleanupManifest();
    let resolveExit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const signal = vi.fn();
    const forceKill = vi.fn(() => resolveExit(137));
    const handlers = new Map<NodeJS.Signals, () => void>();
    let resolveWait: () => void = () => undefined;
    const lifecycle: SignalLifecycle = {
      on: (name, handler) => {
        handlers.set(name, handler);
        return () => handlers.delete(name);
      },
      wait: () =>
        new Promise<void>((resolve) => {
          resolveWait = resolve;
        }),
    };
    const result = runE2e(
      [],
      () => ({ exited, forceKill, signal }),
      () => manifest,
      async () => lease(),
      lifecycle,
    );
    await vi.waitFor(() => expect(handlers).toHaveLength(2));
    handlers.get("SIGTERM")?.();
    expect(signal).toHaveBeenCalledWith("SIGTERM");
    resolveWait();
    await expect(result).resolves.toBe(137);
    expect(forceKill).toHaveBeenCalledOnce();
    expect(handlers).toHaveLength(0);
  });

  it("waits for forced tree termination before cleaning fixtures", async () => {
    const manifest = createE2eCleanupManifest();
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "sharecut-e2e-test-"),
    );
    registerE2eCleanupWorkspace(workspace, manifest.manifestPath);
    let resolveExit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    let resolveForceKill: () => void = () => undefined;
    const forceKill = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveForceKill = resolve;
        }),
    );
    const handlers = new Map<NodeJS.Signals, () => void>();
    let resolveWait: () => void = () => undefined;
    const lifecycle: SignalLifecycle = {
      on: (name, handler) => {
        handlers.set(name, handler);
        return () => handlers.delete(name);
      },
      wait: () =>
        new Promise<void>((resolve) => {
          resolveWait = resolve;
        }),
    };
    const result = runE2e(
      [],
      () => ({ exited, forceKill, signal: vi.fn() }),
      () => manifest,
      async () => lease(),
      lifecycle,
    );
    await vi.waitFor(() => expect(handlers).toHaveLength(2));
    handlers.get("SIGTERM")?.();
    resolveExit(137);
    resolveWait();
    await vi.waitFor(() => expect(forceKill).toHaveBeenCalledOnce());

    expect(fs.existsSync(workspace)).toBe(true);
    resolveForceKill();
    await expect(result).resolves.toBe(137);
    expect(fs.existsSync(workspace)).toBe(false);
  });

  it("retains fixtures when forced tree termination cannot be confirmed", async () => {
    const manifest = createE2eCleanupManifest();
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "sharecut-e2e-test-"),
    );
    registerE2eCleanupWorkspace(workspace, manifest.manifestPath);
    const heldLease = lease();
    let resolveExit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const handlers = new Map<NodeJS.Signals, () => void>();
    let resolveWait: () => void = () => undefined;
    const lifecycle: SignalLifecycle = {
      on: (name, handler) => {
        handlers.set(name, handler);
        return () => handlers.delete(name);
      },
      wait: () =>
        new Promise<void>((resolve) => {
          resolveWait = resolve;
        }),
    };
    const result = runE2e(
      [],
      () => ({
        exited,
        forceKill: () => {
          throw new Error("tree still running");
        },
        signal: () => new Promise<void>(() => undefined),
      }),
      () => manifest,
      async () => heldLease,
      lifecycle,
    );
    await vi.waitFor(() => expect(handlers).toHaveLength(2));
    handlers.get("SIGTERM")?.();
    resolveExit(137);
    resolveWait();

    await expect(result).rejects.toThrow("tree still running");
    expect(fs.existsSync(workspace)).toBe(true);
    expect(fs.existsSync(manifest.manifestDir)).toBe(true);
    expect(heldLease.release).not.toHaveBeenCalled();
    fs.rmSync(manifest.manifestDir, { force: true, recursive: true });
    fs.rmSync(workspace, { force: true, recursive: true });
  });
});
