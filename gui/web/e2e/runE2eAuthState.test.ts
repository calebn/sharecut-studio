import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createE2eCleanupManifest } from "./cleanupManifest";
import { runE2e, type SignalLifecycle } from "./runE2e";
import { e2eRuntimeEnv } from "./runtimeEnv";

function invocationFile(directory: string, file: string | undefined) {
  if (!file) return false;
  const relative = path.relative(directory, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function hostState() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "sharecut-e2e-host-test-"),
  );
  const registry = path.join(directory, "host-registry.sqlite");
  const identity = path.join(directory, "host-identity.sqlite");
  fs.writeFileSync(registry, "host registry unchanged");
  fs.writeFileSync(identity, "host identity unchanged");
  vi.stubEnv("PODCAST_SHARE_REGISTRY", registry);
  vi.stubEnv("PODCAST_SHARE_IDENTITY", identity);
  return {
    registry,
    identity,
    assertUnchanged() {
      expect(fs.readFileSync(registry, "utf8")).toBe("host registry unchanged");
      expect(fs.readFileSync(identity, "utf8")).toBe("host identity unchanged");
      expect(process.env.PODCAST_SHARE_REGISTRY).toBe(registry);
      expect(process.env.PODCAST_SHARE_IDENTITY).toBe(identity);
    },
    dispose() {
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

it("passes distinct private invocation auth stores through runtimeEnv and cleans failed runs", async () => {
  const host = hostState();
  const manifests = [createE2eCleanupManifest(), createE2eCleanupManifest()];
  const childEnvs: NodeJS.ProcessEnv[] = [];
  try {
    for (const [index, manifest] of manifests.entries()) {
      const result = await runE2e(
        ["--grep", "document state"],
        (args, env) => {
          expect(args).toEqual(["--grep", "document state"]);
          const child = e2eRuntimeEnv(env, `auth-state-${index}`);
          childEnvs.push(child);
          for (const key of [
            "PODCAST_SHARE_REGISTRY",
            "PODCAST_SHARE_IDENTITY",
          ]) {
            const file = child[key];
            if (file && invocationFile(manifest.manifestDir, file)) {
              fs.mkdirSync(path.dirname(file), {
                recursive: true,
                mode: 0o700,
              });
              fs.writeFileSync(file, "owned child state");
              expect(fs.statSync(manifest.manifestDir).mode & 0o777).toBe(
                0o700,
              );
            }
          }
          return {
            exited: Promise.resolve(23),
            forceKill: vi.fn(),
            signal: vi.fn(),
          };
        },
        () => manifest,
        async () => ({ port: 43210 + index, release: vi.fn() }),
      );
      expect(result).toBe(23);
      expect(fs.existsSync(manifest.manifestDir)).toBe(false);
    }
    host.assertUnchanged();
    for (const [index, child] of childEnvs.entries()) {
      const registry = child.PODCAST_SHARE_REGISTRY;
      const identity = child.PODCAST_SHARE_IDENTITY;
      expect(invocationFile(manifests[index].manifestDir, registry)).toBe(true);
      expect(invocationFile(manifests[index].manifestDir, identity)).toBe(true);
      expect(registry).not.toBe(identity);
      expect(fs.existsSync(registry ?? "")).toBe(false);
      expect(fs.existsSync(identity ?? "")).toBe(false);
    }
    expect(childEnvs[0].PODCAST_SHARE_REGISTRY).not.toBe(
      childEnvs[1].PODCAST_SHARE_REGISTRY,
    );
    expect(childEnvs[0].PODCAST_SHARE_IDENTITY).not.toBe(
      childEnvs[1].PODCAST_SHARE_IDENTITY,
    );
  } finally {
    for (const manifest of manifests) {
      fs.rmSync(manifest.manifestDir, { recursive: true, force: true });
    }
    host.dispose();
  }
});

it("retains invocation auth stores when process shutdown cannot be confirmed", async () => {
  const host = hostState();
  const manifest = createE2eCleanupManifest();
  const handlers = new Map<NodeJS.Signals, () => void>();
  let finishChild: (code: number) => void = () => undefined;
  let finishWait: () => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    finishChild = resolve;
  });
  const lifecycle: SignalLifecycle = {
    on: (signal, handler) => {
      handlers.set(signal, handler);
      return () => handlers.delete(signal);
    },
    wait: () =>
      new Promise<void>((resolve) => {
        finishWait = resolve;
      }),
  };
  let childEnv: NodeJS.ProcessEnv = {};
  try {
    const result = runE2e(
      [],
      (_args, env) => {
        childEnv = e2eRuntimeEnv(env, "auth-state-retained");
        for (const [key, contents] of [
          ["PODCAST_SHARE_REGISTRY", "owned registry state"],
          ["PODCAST_SHARE_IDENTITY", "owned identity state"],
        ]) {
          const file = childEnv[key];
          if (file && invocationFile(manifest.manifestDir, file)) {
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
            fs.writeFileSync(file, contents);
          }
        }
        return {
          exited,
          signal: () => new Promise<void>(() => undefined),
          forceKill: () => {
            throw new Error("tree still running");
          },
        };
      },
      () => manifest,
      async () => ({ port: 43210, release: vi.fn() }),
      lifecycle,
    );
    await vi.waitFor(() => expect(handlers.size).toBe(2));
    handlers.get("SIGTERM")?.();
    finishChild(137);
    finishWait();
    await expect(result).rejects.toThrow("tree still running");
    host.assertUnchanged();
    expect(fs.existsSync(manifest.manifestDir)).toBe(true);
    expect(
      invocationFile(manifest.manifestDir, childEnv.PODCAST_SHARE_REGISTRY),
    ).toBe(true);
    expect(
      invocationFile(manifest.manifestDir, childEnv.PODCAST_SHARE_IDENTITY),
    ).toBe(true);
    expect(fs.readFileSync(childEnv.PODCAST_SHARE_REGISTRY ?? "", "utf8")).toBe(
      "owned registry state",
    );
    expect(fs.readFileSync(childEnv.PODCAST_SHARE_IDENTITY ?? "", "utf8")).toBe(
      "owned identity state",
    );
  } finally {
    fs.rmSync(manifest.manifestDir, { recursive: true, force: true });
    host.dispose();
  }
});

it("keeps auth store paths stable through repeated config and launcher transforms", () => {
  const manifest = createE2eCleanupManifest();
  const inherited = {
    DAW_E2E_CLEANUP_MANIFEST: manifest.manifestPath,
    PODCAST_SHARE_REGISTRY: "host-registry.sqlite",
    PODCAST_SHARE_IDENTITY: "host-identity.sqlite",
    KEEP: "parent setting",
  };
  try {
    const config = e2eRuntimeEnv(inherited, "config-transform");
    const launcher = e2eRuntimeEnv(config, "launcher-transform");
    expect(
      invocationFile(manifest.manifestDir, config.PODCAST_SHARE_REGISTRY),
    ).toBe(true);
    expect(
      invocationFile(manifest.manifestDir, config.PODCAST_SHARE_IDENTITY),
    ).toBe(true);
    expect(launcher.PODCAST_SHARE_REGISTRY).toBe(config.PODCAST_SHARE_REGISTRY);
    expect(launcher.PODCAST_SHARE_IDENTITY).toBe(config.PODCAST_SHARE_IDENTITY);
    expect(launcher.KEEP).toBe("parent setting");
    expect(inherited).toEqual({
      DAW_E2E_CLEANUP_MANIFEST: manifest.manifestPath,
      PODCAST_SHARE_REGISTRY: "host-registry.sqlite",
      PODCAST_SHARE_IDENTITY: "host-identity.sqlite",
      KEEP: "parent setting",
    });
  } finally {
    fs.rmSync(manifest.manifestDir, { recursive: true, force: true });
  }
});

it("refuses a missing invocation manifest before falling back to host auth stores", () => {
  const inherited = {
    PODCAST_SHARE_REGISTRY: "host-registry.sqlite",
    PODCAST_SHARE_IDENTITY: "host-identity.sqlite",
  };
  expect(() => e2eRuntimeEnv(inherited, "without-manifest")).toThrow(
    /manifest/i,
  );
  expect(inherited).toEqual({
    PODCAST_SHARE_REGISTRY: "host-registry.sqlite",
    PODCAST_SHARE_IDENTITY: "host-identity.sqlite",
  });
});
