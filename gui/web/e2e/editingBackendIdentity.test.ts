import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupE2eManifest,
  createE2eCleanupManifest,
  registerE2eCleanupWorkspace,
} from "./cleanupManifest";
import {
  admitRetainedBackend,
  EditingBackendLaunch,
  verifyEditingBackend,
} from "./editingBackendIdentity";
import { acquireE2ePortLease } from "./port";
import { processTreeTerminator } from "./processTree";
import { e2eRuntimeEnv } from "./runtimeEnv";

function jsonRecord(bytes: string): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a retained JSON record");
  return Object.fromEntries(Object.entries(value));
}

function connectionResult(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(2_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve("timeout");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(error.code ?? "unknown-error");
    });
  });
}

describe.skipIf(process.platform !== "linux")("actual backend identity", () => {
  it("refuses missing, malformed, foreign and mismatched live owner selections before launch", async () => {
    const cwd = fs.realpathSync(path.resolve("../.."));
    const output = fs.mkdtempSync(
      path.join(os.tmpdir(), "sharecut-owner-boundary-"),
    );
    const manifest = createE2eCleanupManifest();
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "sharecut-unowned-"));
    const dist = path.join(output, "dist");
    fs.mkdirSync(dist);
    const module = path.join(cwd, "src/podcast_mcp/gui/server.py");
    const sourceHash = createHash("sha256")
      .update(fs.readFileSync(module))
      .digest("hex");
    const protocolFile = path.join(output, "protocol.json");
    const protocolBytes = JSON.stringify({
      version: 8,
      backend: {
        cwd,
        executable: path.join(cwd, ".venv/bin/python"),
        module,
        sourceHash,
      },
      source: { productFiles: { "src/podcast_mcp/gui/server.py": sourceHash } },
      productionDist: dist,
    });
    fs.writeFileSync(protocolFile, protocolBytes);
    const protocolHash = createHash("sha256")
      .update(protocolBytes)
      .digest("hex");
    const env = e2eRuntimeEnv(
      {
        ...process.env,
        DAW_E2E_CLEANUP_MANIFEST: manifest.manifestPath,
        PODCAST_GUI_DIST: dist,
      },
      "owner-boundary",
    );
    const construct = (environment: NodeJS.ProcessEnv) => {
      const attempt = path.join(output, `attempt-${randomUUID()}`);
      fs.mkdirSync(attempt);
      return new EditingBackendLaunch(
        attempt,
        protocolFile,
        protocolHash,
        43210,
        environment,
      );
    };
    try {
      expect(construct(env).environment.PODCAST_SHARE_REGISTRY).toBe(
        env.PODCAST_SHARE_REGISTRY,
      );
      expect(() =>
        construct({ ...env, DAW_E2E_CLEANUP_MANIFEST: undefined }),
      ).toThrow("E2E cleanup manifest is required");
      expect(() =>
        construct({
          ...env,
          DAW_E2E_CLEANUP_MANIFEST: path.join(
            output,
            "missing/workspaces.json",
          ),
        }),
      ).toThrow();
      fs.writeFileSync(manifest.manifestPath, "{}");
      expect(() => construct(env)).toThrow("E2E cleanup manifest is invalid");
      fs.writeFileSync(
        manifest.manifestPath,
        JSON.stringify({ workspaces: [] }),
      );
      fs.writeFileSync(
        path.join(foreign, "workspaces.json"),
        JSON.stringify({ workspaces: [] }),
      );
      expect(() =>
        construct({
          ...env,
          DAW_E2E_CLEANUP_MANIFEST: path.join(foreign, "workspaces.json"),
        }),
      ).toThrow("E2E cleanup manifest must belong to a private invocation");
      for (const name of ["PODCAST_SHARE_REGISTRY", "PODCAST_SHARE_IDENTITY"]) {
        expect(() =>
          construct({ ...env, [name]: path.join(output, "host.sqlite") }),
        ).toThrow("Editing backend selected auth paths differs");
      }
      fs.chmodSync(manifest.manifestDir, 0o755);
      expect(() => construct(env)).toThrow(
        "E2E cleanup manifest must belong to a private invocation",
      );
      fs.chmodSync(manifest.manifestDir, 0o700);
      fs.renameSync(manifest.manifestPath, `${manifest.manifestPath}.original`);
      fs.symlinkSync(
        `${manifest.manifestPath}.original`,
        manifest.manifestPath,
      );
      expect(() => construct(env)).toThrow(
        "E2E cleanup manifest must belong to a private invocation",
      );
      fs.unlinkSync(manifest.manifestPath);
      fs.renameSync(`${manifest.manifestPath}.original`, manifest.manifestPath);
    } finally {
      fs.chmodSync(manifest.manifestDir, 0o700);
      fs.rmSync(manifest.manifestDir, { recursive: true, force: true });
      fs.rmSync(foreign, { recursive: true, force: true });
      fs.rmSync(output, { recursive: true, force: true });
    }
  });

  it("admits the owned canonical listener and its complete retained proof after shutdown", async () => {
    const cwd = fs.realpathSync(path.resolve("../.."));
    const output = fs.mkdtempSync(
      path.join(os.tmpdir(), "sharecut-owned-backend-"),
    );
    const manifest = createE2eCleanupManifest();
    const lease = await acquireE2ePortLease({});
    const dist = path.join(output, "dist");
    fs.mkdirSync(dist);
    fs.writeFileSync(
      path.join(dist, "index.html"),
      "<html>owned backend fixture</html>",
    );
    const module = path.join(cwd, "src/podcast_mcp/gui/server.py");
    const sourceHash = createHash("sha256")
      .update(fs.readFileSync(module))
      .digest("hex");
    const protocolFile = path.join(output, "protocol.json");
    const protocolBytes = JSON.stringify({
      version: 8,
      backend: {
        cwd,
        executable: path.join(cwd, ".venv/bin/python"),
        module,
        sourceHash,
      },
      source: { productFiles: { "src/podcast_mcp/gui/server.py": sourceHash } },
      productionDist: dist,
    });
    fs.writeFileSync(protocolFile, protocolBytes);
    const protocolHash = createHash("sha256")
      .update(protocolBytes)
      .digest("hex");
    const env = e2eRuntimeEnv(
      {
        ...process.env,
        DAW_E2E_CLEANUP_MANIFEST: manifest.manifestPath,
        PODCAST_GUI_DIST: dist,
      },
      "canonical-identity-test",
    );
    const identity = new EditingBackendLaunch(
      output,
      protocolFile,
      protocolHash,
      lease.port,
      env,
    );
    const command = [
      path.join(cwd, ".venv/bin/podcast"),
      "gui",
      "--host",
      "127.0.0.1",
      "--port",
      String(lease.port),
      "--no-open",
    ];
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: identity.environment,
      stdio: "pipe",
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    child.stdout.resume();
    child.stderr.resume();
    const terminate = async () => {
      await processTreeTerminator().terminate(child.pid!, "SIGTERM");
      await exited;
    };
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      identity.recordChild(child.pid!, command);
      await identity.waitUntilReady();
      const before = await verifyEditingBackend(output, String(lease.port), {
        protocolFile,
        protocolHash,
        environment: env,
        phase: "before",
      });
      const receipt = JSON.parse(
        fs.readFileSync(
          path.join(output, "backend-identity/live.json"),
          "utf8",
        ),
      ) as { pid: number; actual: { module: string; sourceHash: string } };
      expect({ phase: before.phase, pid: before.pid }).toEqual({
        phase: "before",
        pid: child.pid,
      });
      expect(receipt).toMatchObject({
        pid: child.pid,
        actual: { module, sourceHash },
      });
      expect(await connectionResult(lease.port)).toBe("connected");
      const workspace = fs.mkdtempSync(
        path.join(os.tmpdir(), "sharecut-e2e-owner-registration-"),
      );
      expect(
        registerE2eCleanupWorkspace(workspace, manifest.manifestPath),
      ).toBe(true);
      expect(
        JSON.parse(fs.readFileSync(manifest.manifestPath, "utf8")),
      ).toEqual({ workspaces: [workspace] });
      const requestFile = path.join(output, "backend-identity/request.json");
      const requestBytes = fs.readFileSync(requestFile, "utf8");
      fs.writeFileSync(requestFile, `${requestBytes}\n`);
      await expect(
        verifyEditingBackend(output, String(lease.port), {
          protocolFile,
          protocolHash,
          environment: env,
          phase: "after",
          previous: before,
        }),
      ).rejects.toThrow("Editing backend request bytes differs");
      fs.writeFileSync(requestFile, requestBytes);
      const foreign = createE2eCleanupManifest();
      try {
        const foreignEnv = e2eRuntimeEnv(
          { ...env, DAW_E2E_CLEANUP_MANIFEST: foreign.manifestPath },
          "foreign-observer",
        );
        await expect(
          verifyEditingBackend(output, String(lease.port), {
            protocolFile,
            protocolHash,
            environment: foreignEnv,
            phase: "after",
            previous: before,
          }),
        ).rejects.toThrow("Editing backend cleanup owner differs");
      } finally {
        await cleanupE2eManifest(foreign);
      }
      const preservedOwner = `${manifest.manifestDir}-original`;
      fs.renameSync(manifest.manifestDir, preservedOwner);
      try {
        fs.mkdirSync(manifest.manifestDir, { mode: 0o700 });
        fs.copyFileSync(
          path.join(preservedOwner, "workspaces.json"),
          manifest.manifestPath,
        );
        expect(
          fs.statSync(manifest.manifestDir, { bigint: true }).ino ===
            fs.statSync(preservedOwner, { bigint: true }).ino,
        ).toBe(false);
        expect(await connectionResult(lease.port)).toBe("connected");
        await expect(
          verifyEditingBackend(output, String(lease.port), {
            protocolFile,
            protocolHash,
            environment: env,
            phase: "after",
            previous: before,
          }),
        ).rejects.toThrow("Editing backend cleanup owner differs");
      } finally {
        fs.rmSync(manifest.manifestDir, { recursive: true, force: true });
        fs.renameSync(preservedOwner, manifest.manifestDir);
      }
      const after = await verifyEditingBackend(output, String(lease.port), {
        protocolFile,
        protocolHash,
        environment: env,
        phase: "after",
        previous: before,
      });
      expect({
        phase: after.phase,
        pid: after.pid,
        startTime: after.startTime,
        listenerInode: after.listenerInode,
      }).toEqual({
        phase: "after",
        pid: child.pid,
        startTime: before.startTime,
        listenerInode: before.listenerInode,
      });
      const liveFile = path.join(output, "backend-identity/live.json");
      const liveBytes = fs.readFileSync(liveFile, "utf8");
      const changed = JSON.parse(liveBytes) as { actual: { module: string } };
      changed.actual.module = path.join(output, "alternate/server.py");
      fs.writeFileSync(liveFile, JSON.stringify(changed));
      await expect(
        verifyEditingBackend(output, String(lease.port), {
          protocolFile,
          protocolHash,
          environment: env,
          phase: "after",
          previous: before,
        }),
      ).rejects.toThrow("Editing backend actual factory identity differs");
      fs.writeFileSync(liveFile, liveBytes);
      fs.writeFileSync(
        path.join(output, "trial.json"),
        JSON.stringify({ protocolHash, backend: { before, after } }),
      );
      await terminate();
      expect(await connectionResult(lease.port)).toBe("ECONNREFUSED");
      await cleanupE2eManifest(manifest);
      expect(
        [
          manifest.manifestDir,
          manifest.manifestPath,
          env.PODCAST_SHARE_REGISTRY!,
          env.PODCAST_SHARE_IDENTITY!,
          workspace,
        ].map((file) => fs.existsSync(file)),
      ).toEqual([false, false, false, false, false]);
      expect(admitRetainedBackend(output, protocolFile, protocolHash)).toEqual({
        kind: "admitted",
        before,
        after,
      });
      fs.writeFileSync(requestFile, `${requestBytes}\n`);
      expect(
        admitRetainedBackend(output, protocolFile, protocolHash).kind,
      ).toBe("rejected");
      fs.writeFileSync(requestFile, requestBytes);
      const launchFile = path.join(output, "backend-identity/launch.json");
      const launchBytes = fs.readFileSync(launchFile, "utf8");
      const savedBefore = fs.readFileSync(
        path.join(output, "backend-identity/before.json"),
        "utf8",
      );
      const savedAfter = fs.readFileSync(
        path.join(output, "backend-identity/after.json"),
        "utf8",
      );
      const originalOwner = jsonRecord(
        JSON.stringify(jsonRecord(launchBytes).cleanupOwner),
      );
      const incompleteOwner = { ...originalOwner };
      delete incompleteOwner.inode;
      for (const cleanupOwner of [
        null,
        {},
        incompleteOwner,
        { ...originalOwner, extra: "unexpected" },
        { ...originalOwner, directory: "relative" },
        {
          ...originalOwner,
          manifestPath: path.join(output, "workspaces.json"),
        },
        { ...originalOwner, uid: -1 },
        { ...originalOwner, inode: "01" },
        { ...originalOwner, mode: 0o755 },
      ]) {
        const replacement = JSON.stringify({
          ...jsonRecord(launchBytes),
          cleanupOwner,
        });
        fs.writeFileSync(launchFile, replacement);
        const launchHash = createHash("sha256")
          .update(replacement)
          .digest("hex");
        const rebound = (
          phase: "before" | "after",
          saved: string,
          previous: typeof before,
        ) => {
          const observation = jsonRecord(saved);
          observation.launch = { bytes: replacement, sha256: launchHash };
          observation.facts = {
            ...jsonRecord(JSON.stringify(observation.facts)),
            cleanupOwner,
          };
          const bytes = JSON.stringify(observation);
          fs.writeFileSync(
            path.join(output, `backend-identity/${phase}.json`),
            bytes,
          );
          return {
            ...previous,
            launchHash,
            verificationHash: createHash("sha256").update(bytes).digest("hex"),
          };
        };
        const changedBefore = rebound("before", savedBefore, before);
        const changedAfter = rebound("after", savedAfter, after);
        fs.writeFileSync(
          path.join(output, "trial.json"),
          JSON.stringify({
            protocolHash,
            backend: { before: changedBefore, after: changedAfter },
          }),
        );
        expect(
          admitRetainedBackend(output, protocolFile, protocolHash),
        ).toMatchObject({
          kind: "rejected",
          reason: expect.stringMatching(/owner|wire fields|requires/),
        });
      }
      fs.writeFileSync(launchFile, launchBytes);
      fs.writeFileSync(
        path.join(output, "backend-identity/before.json"),
        savedBefore,
      );
      fs.writeFileSync(
        path.join(output, "backend-identity/after.json"),
        savedAfter,
      );
      fs.writeFileSync(
        path.join(output, "trial.json"),
        JSON.stringify({ protocolHash, backend: { before, after } }),
      );
      const afterFile = path.join(output, "backend-identity/after.json");
      const afterBytes = fs.readFileSync(afterFile);
      fs.unlinkSync(afterFile);
      expect(
        admitRetainedBackend(output, protocolFile, protocolHash).kind,
      ).toBe("rejected");
      fs.writeFileSync(afterFile, afterBytes);
      fs.writeFileSync(
        path.join(output, "trial.json"),
        JSON.stringify({
          protocolHash,
          backend: { before, after: { ...after, receiptHash: "b".repeat(64) } },
        }),
      );
      expect(
        admitRetainedBackend(output, protocolFile, protocolHash).kind,
      ).toBe("rejected");
      fs.writeFileSync(
        path.join(output, "trial.json"),
        JSON.stringify({ protocolHash, backend: { before, after } }),
      );
      fs.writeFileSync(protocolFile, `${protocolBytes}\n`);
      expect(
        admitRetainedBackend(output, protocolFile, protocolHash).kind,
      ).toBe("rejected");
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        await terminate();
      const retained = process.env.EDITING_IDENTITY_TEST_RETAIN;
      if (retained) {
        fs.mkdirSync(retained, { recursive: true });
        fs.cpSync(output, path.join(retained, path.basename(output)), {
          recursive: true,
        });
      }
      if (fs.existsSync(manifest.manifestPath))
        await cleanupE2eManifest(manifest);
      lease.release();
      fs.rmSync(output, { force: true, recursive: true });
    }
  }, 45_000);

  it("rejects an owned inert Python process with matching argv and isolation", async () => {
    const cwd = fs.realpathSync(path.resolve("../.."));
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "sharecut-inert-"));
    const manifest = createE2eCleanupManifest();
    const lease = await acquireE2ePortLease({});
    const expected = {
      cwd,
      productionDist: path.join(output, "dist"),
      shareRegistry: path.join(
        fs.realpathSync(manifest.manifestDir),
        "share_registry.sqlite",
      ),
    };
    fs.mkdirSync(expected.productionDist);
    const module = path.join(cwd, "src/podcast_mcp/gui/server.py");
    const sourceHash = createHash("sha256")
      .update(fs.readFileSync(module))
      .digest("hex");
    const protocolFile = path.join(output, "protocol.json");
    const protocolBytes = JSON.stringify({
      version: 8,
      backend: {
        cwd,
        executable: path.join(cwd, ".venv/bin/python"),
        module,
        sourceHash,
      },
      source: { productFiles: { "src/podcast_mcp/gui/server.py": sourceHash } },
      productionDist: expected.productionDist,
    });
    fs.writeFileSync(protocolFile, protocolBytes);
    const protocolHash = createHash("sha256")
      .update(protocolBytes)
      .digest("hex");
    const env = e2eRuntimeEnv(
      {
        ...process.env,
        DAW_E2E_CLEANUP_MANIFEST: manifest.manifestPath,
        PODCAST_GUI_DIST: expected.productionDist,
      },
      "inert-identity-test",
    );
    const identity = new EditingBackendLaunch(
      output,
      protocolFile,
      protocolHash,
      lease.port,
      env,
    );
    const child = spawn(
      path.join(cwd, ".venv/bin/python"),
      [
        "-c",
        "import json,os,sys; print(json.dumps({'pid':os.getpid(),'backendImported':'podcast_mcp.gui.server' in sys.modules}),flush=True); sys.stdin.buffer.read()",
        "gui",
        "--port",
        String(lease.port),
      ],
      {
        cwd,
        env: identity.environment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const startup = await new Promise<string>((resolve, reject) => {
        let text = "";
        timer = setTimeout(
          () => reject(new Error("inert child did not report startup")),
          5_000,
        );
        child.once("error", reject);
        child.once("exit", () =>
          reject(new Error("inert child exited during setup")),
        );
        child.stdout.on("data", (bytes: Buffer) => {
          text += bytes.toString("utf8");
          if (text.includes("\n")) resolve(text.slice(0, text.indexOf("\n")));
        });
      });
      clearTimeout(timer);
      expect(JSON.parse(startup)).toEqual({
        pid: child.pid,
        backendImported: false,
      });
      identity.recordChild(child.pid!, child.spawnargs);
      expect(await connectionResult(lease.port)).toBe("ECONNREFUSED");
      let outcome = "admitted";
      try {
        await verifyEditingBackend(output, String(lease.port), {
          protocolFile,
          protocolHash,
          environment: env,
          phase: "before",
        });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        outcome = "rejected";
      }
      const census = JSON.parse(
        fs.readFileSync(path.join(output, "live-backend.json"), "utf8"),
      ) as Array<{
        pid: number;
        cwd: string;
        productionDist: string;
        shareRegistry: string;
      }>;
      expect(
        census.map(({ pid, cwd, productionDist, shareRegistry }) => ({
          pid,
          cwd,
          productionDist,
          shareRegistry,
        })),
      ).toEqual([{ pid: child.pid, ...expected }]);
      expect(outcome).toBe("rejected");
    } finally {
      const retained = process.env.EDITING_IDENTITY_TEST_RETAIN;
      if (retained) {
        fs.mkdirSync(retained, { recursive: true });
        fs.cpSync(output, path.join(retained, path.basename(output)), {
          recursive: true,
        });
      }
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
      if (fs.existsSync(manifest.manifestPath))
        await cleanupE2eManifest(manifest);
      lease.release();
      fs.rmSync(output, { force: true, recursive: true });
    }
  }, 15_000);
});
