import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerE2eCleanupWorkspace } from "./cleanupManifest";
import { relocateWorkspaceDir } from "./liveProject";
import { silenceWav } from "./shareableProject";

export const CLIP_EXPORTS = [
  { id: "clips/old_c1.wav", name: "old_c1.wav", seconds: 0.1 },
  { id: "clips/current_c1.wav", name: "current_c1.wav", seconds: 0.2 },
] as const;

export function createClipCurrentnessProject(prefix: string) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let registered = false;
  try {
    registered = registerE2eCleanupWorkspace(workspaceDir);
    if (!registered)
      throw new Error("E2E workspace cleanup registration unavailable");
    const projectPath = path.join(workspaceDir, "episode.sharecut");
    fs.copyFileSync(
      new URL("./fixtures/clip-currentness.sharecut", import.meta.url),
      projectPath,
    );
    relocateWorkspaceDir(projectPath, workspaceDir);
    for (const directory of ["raw", "artifacts", "export/clips"])
      fs.mkdirSync(path.join(workspaceDir, directory), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "raw/host.wav"), silenceWav(8));
    fs.writeFileSync(
      path.join(workspaceDir, "artifacts/premix.wav"),
      silenceWav(8),
    );
    for (const file of CLIP_EXPORTS)
      fs.writeFileSync(
        path.join(workspaceDir, "export", file.id),
        silenceWav(file.seconds, 16000),
      );
    return { projectPath, workspaceDir };
  } catch (error) {
    if (!registered) fs.rmSync(workspaceDir, { recursive: true, force: true });
    throw error;
  }
}
