import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyEditingBackend } from "./editingTaskEvidence";
import { acquireE2ePortLease } from "./port";

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
  it("rejects an owned inert Python process with matching argv and isolation", async () => {
    const cwd = fs.realpathSync(path.resolve("../.."));
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "sharecut-inert-"));
    const lease = await acquireE2ePortLease({});
    const expected = {
      cwd,
      productionDist: path.join(output, "dist"),
      shareRegistry: path.join(output, "registry.sqlite"),
    };
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
        env: {
          ...process.env,
          PODCAST_GUI_DIST: expected.productionDist,
          PODCAST_SHARE_REGISTRY: expected.shareRegistry,
        },
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
      expect(await connectionResult(lease.port)).toBe("ECONNREFUSED");
      let outcome = "admitted";
      try {
        verifyEditingBackend(output, String(lease.port), expected);
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
