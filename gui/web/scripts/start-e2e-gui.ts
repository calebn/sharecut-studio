import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EditingBackendLaunch } from "../e2e/editingBackendIdentity";
import { repoRoot } from "../e2e/env";
import { guiCommand } from "../e2e/guiCommand";
import { configuredE2ePort } from "../e2e/port";
import { processTreeTerminator } from "../e2e/processTree";
import { e2eRuntimeEnv } from "../e2e/runtimeEnv";

const port = configuredE2ePort();
if (port === undefined) throw new Error("DAW_E2E_PORT is required");
const pinProject = process.env.DAW_E2E_PIN_PROJECT === "1";
const projectPath = process.env.DAW_E2E_PROJECT;
if (pinProject && !projectPath)
  throw new Error("DAW_E2E_PROJECT is required for a pinned E2E GUI");
const [command, ...args] = guiCommand({
  ci: Boolean(process.env.CI),
  host: "127.0.0.1",
  port,
  pinProject,
  projectPath: projectPath ?? "",
});
const runtimeEnv = e2eRuntimeEnv(process.env, `${process.pid}-${port}`);
if (runtimeEnv.UX_DEMO_SCREENSHOTS) {
  if (!projectPath || !runtimeEnv.UX_DEMO_GUEST_TOKENS)
    throw new Error(
      "UX screenshots require an owned project and token manifest",
    );
  const python = runtimeEnv.CI
    ? "python"
    : path.join(
        repoRoot,
        process.platform === "win32"
          ? ".venv/Scripts/python.exe"
          : ".venv/bin/python",
      );
  const seed = spawn(
    python,
    [
      "scripts/ux_demo_prepare_shares.py",
      "--project",
      projectPath,
      "--registry",
      runtimeEnv.PODCAST_SHARE_REGISTRY ?? "",
      "--base-url",
      `http://127.0.0.1:${port}`,
      "--tokens-out",
      runtimeEnv.UX_DEMO_GUEST_TOKENS,
    ],
    { cwd: repoRoot, env: runtimeEnv, stdio: "inherit" },
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    seed.once("error", reject);
    seed.once("exit", resolve);
  });
  if (code !== 0)
    throw new Error(`UX share preparation failed with exit ${code}`);
}
const editing = [
  process.env.EDITING_TASK_OUT,
  process.env.EDITING_PROTOCOL_FILE,
  process.env.EDITING_PROTOCOL_HASH,
].some((value) => value !== undefined);
if (
  editing &&
  (!process.env.EDITING_TASK_OUT ||
    !process.env.EDITING_PROTOCOL_FILE ||
    !process.env.EDITING_PROTOCOL_HASH)
)
  throw new Error("Editing backend requires attempt and protocol file/hash");
const identity = editing
  ? new EditingBackendLaunch(
      process.env.EDITING_TASK_OUT!,
      process.env.EDITING_PROTOCOL_FILE!,
      process.env.EDITING_PROTOCOL_HASH!,
      port,
      runtimeEnv,
    )
  : undefined;
const child = spawn(command, args, {
  cwd: repoRoot,
  env: identity?.environment ?? runtimeEnv,
  stdio: "inherit",
});
if (identity) {
  child.once("spawn", () => {
    const ready = async () => {
      identity.recordChild(child.pid!, [command, ...args]);
      await identity.waitUntilReady();
    };
    void ready().catch(async (error: unknown) => {
      try {
        fs.writeFileSync(
          path.join(
            process.env.EDITING_TASK_OUT!,
            "backend-identity",
            "failure.json",
          ),
          JSON.stringify({ error: String(error) }),
          { flag: "wx", mode: 0o600 },
        );
      } finally {
        process.exitCode = 1;
        await processTreeTerminator().terminate(child.pid!, "SIGTERM");
      }
    });
  });
}
child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  process.exitCode ??=
    code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
});
