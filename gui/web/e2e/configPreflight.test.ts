import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type ConfigRoute = {
  name: string;
  configPath: "../playwright.config.ts" | "../playwright.compat.config.ts";
  ux: boolean;
};

type ManifestCase = "missing" | "unowned" | "malformed";

type LoadedConfig = {
  webServer?: { env?: NodeJS.ProcessEnv };
};

const routes: ConfigRoute[] = [
  { name: "normal", configPath: "../playwright.config.ts", ux: false },
  { name: "UX", configPath: "../playwright.config.ts", ux: true },
  { name: "compat", configPath: "../playwright.compat.config.ts", ux: false },
  { name: "compat UX", configPath: "../playwright.compat.config.ts", ux: true },
];

const manifestCases: ManifestCase[] = ["missing", "unowned", "malformed"];
const observedEnvNames = [
  "DAW_E2E_CLEANUP_MANIFEST",
  "DAW_E2E_PROJECT",
  "DAW_E2E_WORKSPACE",
  "UX_DEMO_SCREENSHOTS",
  "UX_DEMO_PROJECT",
  "PODCAST_RELAY_TEST_SENTINEL",
  "PODCAST_OBJECT_STORE_BUCKET_SENTINEL",
];

const caseRoots: string[] = [];

function captureEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    observedEnvNames.map((name) => [name, process.env[name]]),
  );
}

function captureFiles(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else {
        files.set(path.relative(root, absolute), fs.readFileSync(absolute));
      }
    }
  };
  visit(root);
  return files;
}

function createCaseRoot(): {
  root: string;
  inputDir: string;
  repoRoot: string;
  tmpDir: string;
  projectPath: string;
} {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sharecut-config-preflight-test-"),
  );
  caseRoots.push(root);
  const inputDir = path.join(root, "input");
  const repoRoot = path.join(root, "repo");
  const tmpDir = path.join(root, "tmp");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const projectPath = path.join(inputDir, "episode.project.json");
  fs.writeFileSync(
    projectPath,
    `${JSON.stringify({ meta: { workspace_dir: inputDir } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(inputDir, "fixture-input.txt"), "fixture bytes\n");
  return { root, inputDir, repoRoot, tmpDir, projectPath };
}

async function loadConfig(
  route: ConfigRoute,
  repoRoot: string,
  projectPath: string,
): Promise<LoadedConfig> {
  vi.resetModules();
  vi.doMock("../e2e/env", () => ({
    e2eBaseURL: "http://127.0.0.1:49444",
    e2ePort: 49444,
    repoRoot,
    committedE2eProjectPath: projectPath,
  }));
  try {
    const loaded = await import(route.configPath);
    return loaded.default as LoadedConfig;
  } finally {
    vi.doUnmock("../e2e/env");
  }
}

function configureRoute(route: ConfigRoute, fixturePath: string): void {
  delete process.env.DAW_E2E_PROJECT;
  delete process.env.DAW_E2E_WORKSPACE;
  delete process.env.UX_DEMO_PROJECT;
  delete process.env.UX_DEMO_SCREENSHOTS;
  process.env.PODCAST_RELAY_TEST_SENTINEL = "host-relay-setting";
  process.env.PODCAST_OBJECT_STORE_BUCKET_SENTINEL =
    "host-object-store-setting";
  if (route.ux) {
    process.env.UX_DEMO_SCREENSHOTS = "1";
    process.env.UX_DEMO_PROJECT = fixturePath;
  }
}

function tempE2eWorkspaces(tmpDir: string): string[] {
  return fs
    .readdirSync(tmpDir)
    .filter(
      (name) =>
        name.startsWith("sharecut-e2e-") &&
        !name.startsWith("sharecut-e2e-cleanup-"),
    )
    .sort();
}

describe("Playwright config cleanup-owner preflight", () => {
  const originalEnv = new Map<string, string | undefined>();

  afterEach(() => {
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    originalEnv.clear();
    for (const root of caseRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    vi.resetModules();
    vi.doUnmock("../e2e/env");
  });

  it.each(
    routes.flatMap((route) =>
      manifestCases.map((manifestCase) => [route, manifestCase] as const),
    ),
  )(
    "refuses %s config without allocating for %s manifest",
    async (route, manifestCase) => {
      const state = createCaseRoot();
      const names = [...observedEnvNames, "TMPDIR"];
      for (const name of names) {
        if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
      }
      process.env.TMPDIR = state.tmpDir;
      configureRoute(route, state.projectPath);

      let manifestPath: string | undefined;
      let manifestBytesBefore: Buffer | undefined;
      if (manifestCase === "unowned" || manifestCase === "malformed") {
        const manifestDir = path.join(
          state.tmpDir,
          manifestCase === "unowned"
            ? "foreign-cleanup"
            : "sharecut-e2e-cleanup-invalid",
        );
        fs.mkdirSync(manifestDir);
        manifestPath = path.join(manifestDir, "workspaces.json");
        manifestBytesBefore =
          manifestCase === "unowned"
            ? Buffer.from('{"workspaces":[]}\n')
            : Buffer.from("{broken manifest\n");
        fs.writeFileSync(manifestPath, manifestBytesBefore);
        process.env.DAW_E2E_CLEANUP_MANIFEST = manifestPath;
      } else {
        delete process.env.DAW_E2E_CLEANUP_MANIFEST;
      }

      const sourceBefore = captureFiles(state.inputDir);
      const envBefore = captureEnv();
      let refusal: string | undefined;
      try {
        await loadConfig(route, state.repoRoot, state.projectPath);
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }

      const stampPath = path.join(
        state.repoRoot,
        "gui/web/test-results/e2e-workspace.txt",
      );
      const manifestBytesAfter = manifestPath
        ? fs.readFileSync(manifestPath)
        : undefined;
      expect({
        refusal,
        workspaces: tempE2eWorkspaces(state.tmpDir),
        workspaceStampExists: fs.existsSync(stampPath),
        envAfter: captureEnv(),
        envBefore,
        sourceAfter: captureFiles(state.inputDir),
        sourceBefore,
        manifestBytesAfter,
        manifestBytesBefore,
      }).toEqual({
        refusal: expect.stringMatching(
          /^E2E cleanup manifest is required|^E2E cleanup manifest must belong|^E2E cleanup manifest is invalid/,
        ),
        workspaces: [],
        workspaceStampExists: false,
        envAfter: envBefore,
        envBefore,
        sourceAfter: sourceBefore,
        sourceBefore,
        manifestBytesAfter: manifestBytesBefore,
        manifestBytesBefore,
      });
    },
  );

  it.each(routes)(
    "loads %s config with its owned fixture and child environment",
    async (route) => {
      const state = createCaseRoot();
      const names = [...observedEnvNames, "TMPDIR"];
      for (const name of names) {
        if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
      }
      process.env.TMPDIR = state.tmpDir;
      configureRoute(route, state.projectPath);
      const sourceBefore = captureFiles(state.inputDir);
      const hostSentinels = {
        relay: process.env.PODCAST_RELAY_TEST_SENTINEL,
        objectStore: process.env.PODCAST_OBJECT_STORE_BUCKET_SENTINEL,
      };

      const manifestModule = await import("./cleanupManifest");
      const manifest = manifestModule.createE2eCleanupManifest();
      process.env.DAW_E2E_CLEANUP_MANIFEST = manifest.manifestPath;
      let failure: unknown;
      try {
        const config = await loadConfig(
          route,
          state.repoRoot,
          state.projectPath,
        );
        const childEnv = config.webServer?.env;
        const fixturePath = route.ux
          ? process.env.UX_DEMO_PROJECT
          : process.env.DAW_E2E_PROJECT;
        const workspaceDir = route.ux
          ? fixturePath && path.dirname(fixturePath)
          : process.env.DAW_E2E_WORKSPACE;
        const registered = JSON.parse(
          fs.readFileSync(manifest.manifestPath, "utf8"),
        ) as { workspaces: string[] };
        const expectedStamp = route.ux ? undefined : `${workspaceDir}\n`;

        expect({
          refusal: undefined,
          fixtureExists: Boolean(fixturePath && fs.existsSync(fixturePath)),
          workspaceExists: Boolean(workspaceDir && fs.existsSync(workspaceDir)),
          registeredWorkspaces: registered.workspaces,
          fixturePath,
          workspaceDir,
          childProject: childEnv?.DAW_E2E_PROJECT,
          childWorkspace: childEnv?.DAW_E2E_WORKSPACE,
          childUxProject: childEnv?.UX_DEMO_PROJECT,
          childRegistry: childEnv?.PODCAST_SHARE_REGISTRY,
          childIdentity: childEnv?.PODCAST_SHARE_IDENTITY,
          childGuestTokens: childEnv?.UX_DEMO_GUEST_TOKENS,
          childRelayConfigDirectory: childEnv?.PODCAST_RELAY_CONFIG
            ? path.dirname(childEnv.PODCAST_RELAY_CONFIG)
            : undefined,
          childRelayConfigName: childEnv?.PODCAST_RELAY_CONFIG
            ? path.basename(childEnv.PODCAST_RELAY_CONFIG)
            : undefined,
          childRelaySentinel: childEnv?.PODCAST_RELAY_TEST_SENTINEL,
          childObjectStoreSentinel:
            childEnv?.PODCAST_OBJECT_STORE_BUCKET_SENTINEL,
          hostSentinels: {
            relay: process.env.PODCAST_RELAY_TEST_SENTINEL,
            objectStore: process.env.PODCAST_OBJECT_STORE_BUCKET_SENTINEL,
          },
          workspaceStamp: fs.existsSync(
            path.join(state.repoRoot, "gui/web/test-results/e2e-workspace.txt"),
          )
            ? fs.readFileSync(
                path.join(
                  state.repoRoot,
                  "gui/web/test-results/e2e-workspace.txt",
                ),
                "utf8",
              )
            : undefined,
          expectedStamp,
          sourceAfter: captureFiles(state.inputDir),
          sourceBefore,
        }).toEqual({
          refusal: undefined,
          fixtureExists: true,
          workspaceExists: true,
          registeredWorkspaces: [workspaceDir],
          fixturePath,
          workspaceDir,
          childProject: fixturePath,
          childWorkspace: route.ux ? undefined : workspaceDir,
          childUxProject: route.ux ? fixturePath : undefined,
          childRegistry: path.join(
            manifest.manifestDir,
            "share_registry.sqlite",
          ),
          childIdentity: path.join(
            manifest.manifestDir,
            "share_identity.sqlite",
          ),
          childGuestTokens: route.ux
            ? path.join(manifest.manifestDir, "guest-tokens.json")
            : undefined,
          childRelayConfigDirectory: state.tmpDir,
          childRelayConfigName: expect.stringMatching(
            /^sharecut-e2e-relay-.*\.yaml$/,
          ),
          childRelaySentinel: undefined,
          childObjectStoreSentinel: undefined,
          hostSentinels,
          workspaceStamp: expectedStamp,
          expectedStamp,
          sourceAfter: sourceBefore,
          sourceBefore,
        });
        expect(tempE2eWorkspaces(state.tmpDir)).toContain(
          path.basename(workspaceDir as string),
        );
      } catch (error) {
        failure = error;
      } finally {
        const cleanupModule = await import("./cleanupManifest");
        await cleanupModule.cleanupE2eManifest(manifest).catch((error) => {
          failure ??= error;
        });
      }
      if (failure) throw failure;
    },
  );
});
