import { spawn } from "node:child_process";
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
const child = spawn(command, args, {
  cwd: repoRoot,
  env: e2eRuntimeEnv(process.env, `${process.pid}-${port}`),
  stdio: "inherit",
});
child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  process.exitCode =
    code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
});
