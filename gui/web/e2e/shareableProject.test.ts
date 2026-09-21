import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { e2eProjectPath } from "./env";
import { E2E_FIXTURE_COPY_TEST_TIMEOUT_MS } from "./liveProject";
import { switchE2eProject, withShareableProject } from "./shareableProject";

describe("withShareableProject", () => {
  it("opens a fresh socket even when fetch has an idle pooled socket", async () => {
    const sockets: object[] = [];
    const server = createServer((request, response) => {
      sockets.push(request.socket);
      response.end("ok");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      await (await fetch(url)).text();
      await setTimeout(25);
      await switchE2eProject("/tmp/episode.project.json", url);
      expect(sockets).toHaveLength(2);
      expect(sockets[1]).not.toBe(sockets[0]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports a reset as a transport error", async () => {
    const server = createServer((request) => request.socket.destroy());
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      await expect(
        switchE2eProject("/tmp/episode.project.json", url),
      ).rejects.toThrow(/failed during transport:.*ECONNRESET/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

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
