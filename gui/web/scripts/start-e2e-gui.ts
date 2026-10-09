import { spawn } from "node:child_process";
import path from "node:path";
import { repoRoot } from "../e2e/env";
import { guiCommand } from "../e2e/guiCommand";
import { configuredE2ePort } from "../e2e/port";
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
const env = e2eRuntimeEnv(process.env, `${process.pid}-${port}`);
if (env.UX_DEMO_SCREENSHOTS) {
  if (!projectPath || !env.UX_DEMO_GUEST_TOKENS)
    throw new Error(
      "UX screenshots require an owned project and token manifest",
    );
  const python = env.CI
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
      env.PODCAST_SHARE_REGISTRY ?? "",
      "--base-url",
      `http://127.0.0.1:${port}`,
      "--tokens-out",
      env.UX_DEMO_GUEST_TOKENS,
    ],
    { cwd: repoRoot, env, stdio: "inherit" },
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    seed.once("error", reject);
    seed.once("exit", resolve);
  });
  if (code !== 0)
    throw new Error(`UX share preparation failed with exit ${code}`);
}
const child = spawn(command, args, {
  cwd: repoRoot,
  env,
  stdio: "inherit",
});
child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  process.exitCode =
    code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
});
