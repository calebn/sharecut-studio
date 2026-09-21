import fs from "node:fs";
import path from "node:path";
import { e2eBaseURL, e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";

const PROJECT_SWITCH_TIMEOUT_MS = 10_000;

function describeTransportError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const code =
    "code" in error && typeof error.code === "string" ? ` (${error.code})` : "";
  const summary = `${error.name}: ${error.message}${code}`;
  if (error.cause instanceof Error && error.cause !== error) {
    return `${summary}; cause: ${describeTransportError(error.cause)}`;
  }
  return summary;
}

export type ProjectSwitcher = (projectPath: string) => Promise<void>;

/** Retarget the loopback GUI through its authenticated project-open endpoint. */
export const switchE2eProject: ProjectSwitcher = async (projectPath) => {
  let response: Response;
  try {
    response = await fetch(new URL("/api/project/open", e2eBaseURL), {
      method: "POST",
      // Project switches happen between long-running browser scenarios. Do
      // not reuse an idle undici socket that the loopback server may have
      // already closed while the suite was exercising WebSockets.
      headers: {
        "Content-Type": "application/json",
        Connection: "close",
      },
      body: JSON.stringify({ path: projectPath }),
      signal: AbortSignal.timeout(PROJECT_SWITCH_TIMEOUT_MS),
    });
  } catch (error) {
    const detail = describeTransportError(error);
    const timeout =
      error instanceof DOMException && error.name === "TimeoutError";
    throw new Error(
      timeout
        ? `E2E project switch to ${projectPath} timed out after ${PROJECT_SWITCH_TIMEOUT_MS}ms`
        : `E2E project switch to ${projectPath} failed during transport: ${detail}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(
      `E2E project switch to ${projectPath} failed (${response.status}): ${await response.text()}`,
    );
  }
};

export function silenceWav(seconds = 0.25, sampleRate = 48000): Buffer {
  const n = Math.floor(seconds * sampleRate);
  const dataSize = n * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

export async function withShareableProject<T>(
  fn: (projectPath: string) => Promise<T>,
  switchProject: ProjectSwitcher = switchE2eProject,
): Promise<T> {
  // Sharing and recording persist state beside a project. Give every callback
  // a new path so WebSocket rooms and rosters cannot leak across scenarios.
  const { projectPath, workspaceDir: root } = createRelocatedE2eProject(
    "sharecut-e2e-share-",
  );
  const art = path.join(root, "artifacts");
  const premix = path.join(art, "premix.wav");
  fs.mkdirSync(art, { recursive: true });
  if (!fs.existsSync(premix)) {
    fs.writeFileSync(premix, silenceWav());
  }
  try {
    await switchProject(projectPath);
    return await fn(projectPath);
  } finally {
    try {
      await switchProject(e2eProjectPath);
    } finally {
      removeRelocatedE2eProject(root);
    }
  }
}
