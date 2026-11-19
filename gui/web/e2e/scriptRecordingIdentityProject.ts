import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerE2eCleanupWorkspace } from "./cleanupManifest";
import { relocateWorkspaceDir } from "./liveProject";
import { silenceWav } from "./shareableProject";

export function createScriptRecordingIdentityProject(prefix: string) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let registered = false;
  try {
    registered = registerE2eCleanupWorkspace(workspaceDir);
    if (!registered)
      throw new Error("E2E workspace cleanup registration unavailable");
    const projectPath = path.join(workspaceDir, "episode.sharecut");
    fs.copyFileSync(
      new URL("./fixtures/script-recording-identity.sharecut", import.meta.url),
      projectPath,
    );
    relocateWorkspaceDir(projectPath, workspaceDir);
    fs.mkdirSync(path.join(workspaceDir, "raw"));
    for (const name of ["primary", "other"]) {
      fs.writeFileSync(
        path.join(workspaceDir, "raw", `${name}.wav`),
        silenceWav(10),
      );
    }
    return { projectPath, workspaceDir };
  } catch (error) {
    if (!registered) fs.rmSync(workspaceDir, { recursive: true, force: true });
    throw error;
  }
}
