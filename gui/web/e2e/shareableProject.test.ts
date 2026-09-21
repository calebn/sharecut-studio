import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { e2eProjectPath } from "./env";
import { E2E_FIXTURE_COPY_TEST_TIMEOUT_MS } from "./liveProject";
import { withShareableProject } from "./shareableProject";

describe("withShareableProject", () => {
  it(
    "uses a unique disposable project for each callback",
    async () => {
      const paths: string[] = [];
      const switched: string[] = [];
      const switchProject = async (projectPath: string) => {
        switched.push(projectPath);
      };
      await withShareableProject(async (projectPath) => {
        paths.push(projectPath);
        fs.writeFileSync(path.join(path.dirname(projectPath), "probe"), "one");
      }, switchProject);
      await withShareableProject(async (projectPath) => {
        paths.push(projectPath);
        expect(
          fs.existsSync(path.join(path.dirname(projectPath), "probe")),
        ).toBe(false);
      }, switchProject);

      expect(paths[0]).not.toBe(paths[1]);
      expect(switched).toEqual([
        paths[0],
        e2eProjectPath,
        paths[1],
        e2eProjectPath,
      ]);
      expect(fs.existsSync(path.dirname(paths[0]))).toBe(false);
      expect(fs.existsSync(path.dirname(paths[1]))).toBe(false);
    },
    E2E_FIXTURE_COPY_TEST_TIMEOUT_MS,
  );

  it(
    "restores the suite project and cleans up when the callback fails",
    async () => {
      const switched: string[] = [];
      let workspaceDir = "";
      await expect(
        withShareableProject(
          async (projectPath) => {
            workspaceDir = path.dirname(projectPath);
            throw new Error("callback failed");
          },
          async (projectPath) => {
            switched.push(projectPath);
          },
        ),
      ).rejects.toThrow("callback failed");

      expect(switched).toEqual([
        path.join(workspaceDir, "episode.project.json"),
        e2eProjectPath,
      ]);
      expect(fs.existsSync(workspaceDir)).toBe(false);
    },
    E2E_FIXTURE_COPY_TEST_TIMEOUT_MS,
  );
});
