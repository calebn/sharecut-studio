import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  admitRetainedBackend,
  EditingBackendLaunch,
  verifyEditingBackend,
} from "./editingBackendIdentity";
import { acquireE2ePortLease } from "./port";
import { processTreeTerminator } from "./processTree";

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
  it("admits the owned canonical listener and its complete retained proof after shutdown", async () => {
    const cwd = fs.realpathSync(path.resolve("../.."));
    const output = fs.mkdtempSync(
      path.join(os.tmpdir(), "sharecut-owned-backend-"),
    );
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
    const identity = new EditingBackendLaunch(
      output,
      protocolFile,
      protocolHash,
      lease.port,
      {
        ...process.env,
        PODCAST_GUI_DIST: dist,
        PODCAST_SHARE_REGISTRY: path.join(output, "share-registry.sqlite"),
      },
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
      const after = await verifyEditingBackend(output, String(lease.port), {
        protocolFile,
        protocolHash,
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
      expect(admitRetainedBackend(output, protocolFile, protocolHash)).toEqual({
        kind: "admitted",
        before,
        after,
      });
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
      lease.release();
      fs.rmSync(output, { force: true, recursive: true });
    }
  }, 45_000);

  it("rejects an owned inert Python process with matching argv and isolation", async () => {
    const cwd = fs.realpathSync(path.resolve("../.."));
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "sharecut-inert-"));
    const lease = await acquireE2ePortLease({});
    const expected = {
      cwd,
      productionDist: path.join(output, "dist"),
      shareRegistry: path.join(output, "share-registry.sqlite"),
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
    const env = {
      ...process.env,
      PODCAST_GUI_DIST: expected.productionDist,
      PODCAST_SHARE_REGISTRY: expected.shareRegistry,
    };
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
      lease.release();
      fs.rmSync(output, { force: true, recursive: true });
    }
  }, 15_000);
});
