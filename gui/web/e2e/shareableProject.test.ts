import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { committedE2eProjectPath, e2eProjectPath } from "./env";
import { createRelocatedE2eProject } from "./liveProject";
import {
  assertDisposableE2eProject,
  switchE2eProject,
  withShareableProject,
} from "./shareableProject";

const suiteProjectPath = path.join(
  os.tmpdir(),
  "sharecut-e2e-suite-probe",
  "episode.project.json",
);

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

describe("assertDisposableE2eProject", () => {
  it("rejects the committed fixture path", () => {
    expect(() => assertDisposableE2eProject(committedE2eProjectPath)).toThrow(
      /committed fixture/,
    );
  });

  it("rejects a dot-relative spelling of the committed fixture", () => {
    const spelled = path.join(
      path.dirname(committedE2eProjectPath),
      ".",
      "episode.project.json",
    );
    expect(() => assertDisposableE2eProject(spelled)).toThrow(
      /committed fixture/,
    );
  });

  it("rejects a cwd-relative spelling of the committed fixture", () => {
    const relative = path.relative(process.cwd(), committedE2eProjectPath);
    expect(() => assertDisposableE2eProject(relative)).toThrow(
      /committed fixture/,
    );
  });

  it("accepts a disposable suite project path", () => {
    expect(() => assertDisposableE2eProject(suiteProjectPath)).not.toThrow();
  });
});

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

  it("refuses to switch to the committed fixture and makes no request", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end("ok");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      await expect(
        switchE2eProject(committedE2eProjectPath, url),
      ).rejects.toThrow(/committed fixture/);
      expect(requests).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses withShareableProject when the restore path is the committed fixture", async () => {
    const switchSpy = vi.fn(async () => {});
    const createSpy = vi.fn();

    await expect(
      withShareableProject(
        async () => {},
        switchSpy,
        createSpy,
        committedE2eProjectPath,
      ),
    ).rejects.toThrow(/committed fixture/);

    expect(switchSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it.runIf(e2eProjectPath === committedE2eProjectPath)(
    "refuses withShareableProject's default restore path when it falls back to the committed fixture",
    async () => {
      const switchSpy = vi.fn(async () => {});
      const createSpy = vi.fn();

      await expect(
        withShareableProject(async () => {}, switchSpy, createSpy),
      ).rejects.toThrow(/committed fixture/);

      expect(switchSpy).not.toHaveBeenCalled();
      expect(createSpy).not.toHaveBeenCalled();
    },
  );

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
        suiteProjectPath,
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
        suiteProjectPath,
      );
    } finally {
      cleanup();
    }

    expect(paths[0]).not.toBe(paths[1]);
    expect(switched).toEqual([
      paths[0],
      suiteProjectPath,
      paths[1],
      suiteProjectPath,
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
          suiteProjectPath,
        ),
      ).rejects.toThrow("callback failed");
    } finally {
      cleanup();
    }

    expect(switched).toEqual([
      path.join(workspaceDir, "episode.project.json"),
      suiteProjectPath,
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
            if (projectPath === suiteProjectPath) {
              throw new Error("restore failed");
            }
          },
          createProject,
          suiteProjectPath,
        ),
      ).rejects.toThrow("callback failed");
    } finally {
      cleanup();
    }

    expect(switched).toEqual([
      path.join(workspaceDir, "episode.project.json"),
      suiteProjectPath,
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
            if (projectPath === suiteProjectPath) {
              throw new Error("restore failed");
            }
          },
          createProject,
          suiteProjectPath,
        ),
      ).rejects.toThrow("restore failed");
    } finally {
      cleanup();
    }

    expect(switched).toEqual([
      path.join(workspaceDir, "episode.project.json"),
      suiteProjectPath,
    ]);
    expect(fs.existsSync(workspaceDir)).toBe(false);
  });
});
