import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { e2eProjectPath } from "./env";
import { createRelocatedE2eProject } from "./liveProject";
import { switchE2eProject, withShareableProject } from "./shareableProject";

function createMinimalProjectFactory(
  writeFile: (filePath: string, content: string) => void = fs.writeFileSync,
): {
  createProject: (
    prefix: string,
  ) => ReturnType<typeof createRelocatedE2eProject>;
  cleanup: () => void;
} {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "sharecut-e2e-share-fixture-"),
  );
  try {
    writeFile(
      path.join(fixtureRoot, "episode.project.json"),
      JSON.stringify({ meta: { workspace_dir: "." } }),
    );
  } catch (error) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    createProject: (prefix) =>
      createRelocatedE2eProject(prefix, undefined, fixtureRoot),
    cleanup: () => fs.rmSync(fixtureRoot, { recursive: true, force: true }),
  };
}

describe("withShareableProject", () => {
  it("cleans up its fixture root when the initial project write fails", () => {
    let fixtureRoot = "";

    expect(() =>
      createMinimalProjectFactory((projectPath) => {
        fixtureRoot = path.dirname(projectPath);
        throw new Error("initial write failed");
      }),
    ).toThrow("initial write failed");

    expect(fs.existsSync(fixtureRoot)).toBe(false);
  });

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

  it("uses a unique disposable project for each callback", async () => {
    const { createProject, cleanup } = createMinimalProjectFactory();
    const paths: string[] = [];
    const switched: string[] = [];
    const switchProject = async (projectPath: string) => {
      switched.push(projectPath);
    };
    try {
      await withShareableProject(
        async (projectPath) => {
          paths.push(projectPath);
          fs.writeFileSync(
            path.join(path.dirname(projectPath), "probe"),
            "one",
          );
        },
        switchProject,
        createProject,
      );
      await withShareableProject(
        async (projectPath) => {
          paths.push(projectPath);
          expect(
            fs.existsSync(path.join(path.dirname(projectPath), "probe")),
          ).toBe(false);
        },
        switchProject,
        createProject,
      );
    } finally {
      cleanup();
    }

    expect(paths[0]).not.toBe(paths[1]);
    expect(switched).toEqual([
      paths[0],
      e2eProjectPath,
      paths[1],
      e2eProjectPath,
    ]);
    expect(fs.existsSync(path.dirname(paths[0]))).toBe(false);
    expect(fs.existsSync(path.dirname(paths[1]))).toBe(false);
  });

  it("restores the suite project and cleans up when the callback fails", async () => {
    const { createProject, cleanup } = createMinimalProjectFactory();
    const switched: string[] = [];
    let workspaceDir = "";
    try {
      await expect(
        withShareableProject(
          async (projectPath) => {
            workspaceDir = path.dirname(projectPath);
            throw new Error("callback failed");
          },
          async (projectPath) => {
            switched.push(projectPath);
          },
          createProject,
        ),
      ).rejects.toThrow("callback failed");
    } finally {
      cleanup();
    }

    expect(switched).toEqual([
      path.join(workspaceDir, "episode.project.json"),
      e2eProjectPath,
    ]);
    expect(fs.existsSync(workspaceDir)).toBe(false);
  });

  it("preserves a callback failure when restoring the suite project also fails", async () => {
    const { createProject, cleanup } = createMinimalProjectFactory();
    const switched: string[] = [];
    let workspaceDir = "";
    try {
      await expect(
        withShareableProject(
          async (projectPath) => {
            workspaceDir = path.dirname(projectPath);
            throw new Error("callback failed");
          },
          async (projectPath) => {
            switched.push(projectPath);
            if (projectPath === e2eProjectPath) {
              throw new Error("restore failed");
            }
          },
          createProject,
        ),
      ).rejects.toThrow("callback failed");
    } finally {
      cleanup();
    }

    expect(switched).toEqual([
      path.join(workspaceDir, "episode.project.json"),
      e2eProjectPath,
    ]);
    expect(fs.existsSync(workspaceDir)).toBe(false);
  });

  it("surfaces a restore failure after a successful callback and still cleans up", async () => {
    const { createProject, cleanup } = createMinimalProjectFactory();
    const switched: string[] = [];
    let workspaceDir = "";
    try {
      await expect(
        withShareableProject(
          async (projectPath) => {
            workspaceDir = path.dirname(projectPath);
          },
          async (projectPath) => {
            switched.push(projectPath);
            if (projectPath === e2eProjectPath) {
              throw new Error("restore failed");
            }
          },
          createProject,
        ),
      ).rejects.toThrow("restore failed");
    } finally {
      cleanup();
    }

    expect(switched).toEqual([
      path.join(workspaceDir, "episode.project.json"),
      e2eProjectPath,
    ]);
    expect(fs.existsSync(workspaceDir)).toBe(false);
  });
});
