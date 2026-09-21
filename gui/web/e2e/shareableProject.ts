import fs from "node:fs";
import { request } from "node:http";
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
export type ShareableProjectFactory = (
  prefix: string,
) => ReturnType<typeof createRelocatedE2eProject>;

/** Retarget the loopback GUI through its authenticated project-open endpoint. */
export const switchE2eProject = async (
  projectPath: string,
  baseURL = e2eBaseURL,
): Promise<void> => {
  const body = JSON.stringify({ path: projectPath });
  let response: { status: number; body: string };
  try {
    response = await new Promise((resolve, reject) => {
      const outgoing = request(
        new URL("/api/project/open", baseURL),
        {
          method: "POST",
          // agent: false creates a new connection for this request. A
          // Connection: close header on fetch can still reuse an idle socket.
          agent: false,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          signal: AbortSignal.timeout(PROJECT_SWITCH_TIMEOUT_MS),
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });
          incoming.once("end", () => {
            resolve({
              status: incoming.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
          incoming.once("error", reject);
        },
      );
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  } catch (error) {
    const detail = describeTransportError(error);
    const timeout =
      error instanceof Error &&
      (error.name === "TimeoutError" ||
        (error.cause instanceof Error && error.cause.name === "TimeoutError"));
    throw new Error(
      timeout
        ? `E2E project switch to ${projectPath} timed out after ${PROJECT_SWITCH_TIMEOUT_MS}ms`
        : `E2E project switch to ${projectPath} failed during transport: ${detail}`,
      { cause: error },
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `E2E project switch to ${projectPath} failed (${response.status}): ${response.body}`,
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
  createProject: ShareableProjectFactory = (prefix) =>
    createRelocatedE2eProject(prefix),
): Promise<T> {
  // Sharing and recording persist state beside a project. Give every callback
  // a new path so WebSocket rooms and rosters cannot leak across scenarios.
  const { projectPath, workspaceDir: root } = createProject(
    "sharecut-e2e-share-",
  );
  let primaryFailed = false;
  let primaryError: unknown;
  let result!: T;
  try {
    const art = path.join(root, "artifacts");
    const premix = path.join(art, "premix.wav");
    fs.mkdirSync(art, { recursive: true });
    if (!fs.existsSync(premix)) {
      fs.writeFileSync(premix, silenceWav());
    }
    await switchProject(projectPath);
    result = await fn(projectPath);
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }

  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    await switchProject(e2eProjectPath);
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  try {
    removeRelocatedE2eProject(root);
  } catch (error) {
    if (!cleanupFailed) {
      cleanupFailed = true;
      cleanupError = error;
    }
  }
  // A setup or scenario failure is more useful than a subsequent cleanup
  // failure. Still attempt restoration before removing the workspace.
  if (primaryFailed) throw primaryError;
  if (cleanupFailed) throw cleanupError;
  return result as T;
}
