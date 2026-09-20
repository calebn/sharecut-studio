import path from "node:path";
import { fileURLToPath } from "node:url";
import { configuredE2ePort } from "./port";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const repoRoot = path.resolve(webRoot, "../..");

export const committedE2eProjectPath = path.join(
  repoRoot,
  "tests/fixtures/aligned_dialogue/episode.project.json",
);

export const e2eProjectPath =
  process.env.DAW_E2E_PROJECT || committedE2eProjectPath;

export const e2eHost = "127.0.0.1";
// The wrapper owns allocation. Config imports only consume its published value.
export const e2ePort = configuredE2ePort() ?? 8766;

export function e2eUrl(port = e2ePort): string {
  return `http://${e2eHost}:${port}`;
}

export const e2eBaseURL = e2eUrl();
