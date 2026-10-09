import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CDPSession, Page, TestInfo } from "@playwright/test";
import { expect, vi } from "vitest";
import { editingTaskRegistry } from "../e2e/editingTaskCases";
import type { TrialAssessment } from "../e2e/editingTaskReport";
import { trial as fixtureTrial } from "../e2e/editingTaskTestFixtures";

type ProfileFault =
  | "complete"
  | "metadata"
  | "attachment"
  | "missing-status"
  | "malformed-status"
  | "missing-errors"
  | "malformed-errors"
  | "nonempty-errors"
  | "missing-schema"
  | "malformed-schema"
  | "future-schema"
  | "missing-measurement"
  | "unknown-measurement"
  | "missing-build"
  | "mismatched-asset"
  | "nonfinite-duration"
  | "nonzero-runner"
  | "mismatched-task"
  | "mismatched-route"
  | "failed-semantics";

type BackendCall = {
  command: "uv";
  argv: readonly ["run", "python", "-c", string];
  cwd: string;
  encoding: "utf8";
};
type ProcessFault =
  | {
      phase: "backend" | "build";
      kind:
        | "spawn-error"
        | "nonzero"
        | "signal"
        | "missing-stdout"
        | "missing-stderr";
    }
  | { phase: "backend"; kind: "invalid-json" }
  | { phase: "backend"; kind: "invalid-metadata"; metadata: unknown };
type BuildCall = {
  command: "npm";
  argv: readonly ["run", "build"];
  encoding: "utf8";
  nodeEnv: "production";
  viteSharecutE2e: null;
};
type ActualChildProcess = typeof import("node:child_process") & {
  default: typeof import("node:child_process");
};

const invocationState = vi.hoisted(() => ({
  kind: "complete" as ProfileFault,
  repo: "",
  project: "",
  asset: "",
  out: "",
  cleanupAt: 0,
  launched: [] as string[],
  cleanupWorkspace: "",
  cleanupManifest: "",
  rejectedLifecycle: null as string | null,
  removalAttempts: 0,
  restored: [] as (() => void)[],
  failLedgerWrite: false,
  backendCalls: [] as BackendCall[],
  processFault: null as ProcessFault | null,
  processResult: null as ReturnType<ActualChildProcess["spawnSync"]> | null,
  missingExecutable: "",
  buildCalls: [] as BuildCall[],
}));

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<ActualChildProcess>("node:child_process");
  const importCommand =
    "import json,os,sys,podcast_mcp.gui.server; print(json.dumps({'cwd':os.getcwd(),'executable':sys.executable,'module':podcast_mcp.gui.server.__file__}))";
  function faultResult(
    fault: ProcessFault,
    stdout: string,
  ): ReturnType<typeof actual.spawnSync> {
    let result: ReturnType<typeof actual.spawnSync>;
    switch (fault.kind) {
      case "spawn-error":
        result = actual.spawnSync(invocationState.missingExecutable, [], {
          cwd: invocationState.repo,
          encoding: "utf8",
        });
        break;
      case "nonzero":
        result = actual.spawnSync(
          process.execPath,
          [
            "-e",
            'process.stderr.write("literal process boundary failure\\n"); process.exit(23);',
          ],
          { cwd: invocationState.repo, encoding: "utf8" },
        );
        break;
      case "signal":
        result = actual.spawnSync(
          process.execPath,
          [
            "-e",
            'process.stderr.write("literal process signal failure\\n", () => process.kill(process.pid, "SIGTERM"));',
          ],
          { cwd: invocationState.repo, encoding: "utf8" },
        );
        break;
      default: {
        if (fault.kind === "invalid-json") stdout = "literal invalid JSON\n";
        if (fault.kind === "invalid-metadata")
          stdout = `${JSON.stringify(fault.metadata)}\n`;
        result = {
          pid: 0,
          status: 0,
          signal: null,
          stdout,
          stderr: "",
          output: [null, stdout, ""],
        };
        if (fault.kind === "missing-stdout") {
          result.stdout = null as unknown as string;
          result.output[1] = null;
        }
        if (fault.kind === "missing-stderr") {
          result.stderr = null as unknown as string;
          result.output[2] = null;
        }
      }
    }
    invocationState.processResult = result;
    return result;
  }
  const spawnSync = (
    ...args: Parameters<typeof actual.spawnSync>
  ): ReturnType<typeof actual.spawnSync> => {
    const [command, argv, options] = args;
    if (
      command === "uv" &&
      Array.isArray(argv) &&
      JSON.stringify(argv) ===
        JSON.stringify(["run", "python", "-c", importCommand]) &&
      options?.cwd === invocationState.repo &&
      options.encoding === "utf8"
    ) {
      invocationState.backendCalls.push({
        command,
        argv: [argv[0], argv[1], argv[2], argv[3]],
        cwd: options.cwd,
        encoding: options.encoding,
      });
      const module = path.join(
        invocationState.repo,
        "src/podcast_mcp/gui/server.py",
      );
      fs.readFileSync(module);
      const stdout = `${JSON.stringify({
        cwd: invocationState.repo,
        executable: "controlled-backend-import-boundary",
        module,
      })}\n`;
      if (invocationState.processFault?.phase === "backend")
        return faultResult(invocationState.processFault, stdout);
      return {
        pid: 0,
        status: 0,
        signal: null,
        stdout,
        stderr: "",
        output: [null, stdout, ""],
      };
    }
    if (
      invocationState.processFault?.phase === "build" &&
      command === "npm" &&
      Array.isArray(argv) &&
      JSON.stringify(argv) === JSON.stringify(["run", "build"]) &&
      options?.encoding === "utf8" &&
      options.env?.NODE_ENV === "production" &&
      !Object.hasOwn(options.env, "VITE_SHARECUT_E2E")
    ) {
      invocationState.buildCalls.push({
        command,
        argv: [argv[0], argv[1]],
        encoding: options.encoding,
        nodeEnv: options.env.NODE_ENV,
        viteSharecutE2e: null,
      });
      return faultResult(invocationState.processFault, "");
    }
    return actual.spawnSync(...args);
  };
  return {
    ...actual,
    spawnSync,
    default: { ...actual.default, spawnSync },
  };
});

vi.mock("../e2e/editingBackendIdentity", async () => {
  const actual = await vi.importActual<
    typeof import("../e2e/editingBackendIdentity")
  >("../e2e/editingBackendIdentity");
  return {
    ...actual,
    admitRetainedBackend: () => ({
      kind: "admitted",
      before: { phase: "before" },
      after: { phase: "after" },
    }),
  };
});

vi.mock("../e2e/runE2e", async () => {
  const actual =
    await vi.importActual<typeof import("../e2e/runE2e")>("../e2e/runE2e");
  return {
    ...actual,
    runE2e: async (args: string[]) => {
      const runner = (_args: string[], env: NodeJS.ProcessEnv) => ({
        exited: (async () => {
          const attempt = env.EDITING_TASK_OUT!;
          invocationState.launched.push(attempt);
          const task = editingTaskRegistry.find((row) => row.id === "trim")!;
          const semantic = fixtureTrial();
          Object.assign(semantic, {
            route: "handle-keyboard",
            mode: "baseline",
            before: structuredClone(task.start),
            after: structuredClone(task.expected),
            undone: structuredClone(task.start),
            cancellations: [
              {
                probe: "cancel",
                outcome: "completed",
                state: structuredClone(task.start),
              },
            ],
          });
          if (invocationState.kind === "nonfinite-duration")
            semantic.durationMs = Infinity;
          if (invocationState.kind === "mismatched-task")
            semantic.task = "range-cut";
          if (invocationState.kind === "mismatched-route")
            semantic.route = "handle-pointer";
          if (invocationState.kind === "failed-semantics") {
            semantic.failures.push({
              origin: { owner: "main", phase: "action" },
              error: "literal saved-action failure",
              errorName: "Error",
            });
          }
          fs.writeFileSync(
            path.join(attempt, "trial.json"),
            JSON.stringify(semantic),
          );

          const { createEditorProfiler } = await vi.importActual<
            typeof import("../e2e/editorProfile")
          >("../e2e/editorProfile");
          const page = new EventEmitter();
          let finishing = false;
          Object.assign(page, {
            context: () => ({
              browser: () => ({ version: () => "controlled-profiler-browser" }),
            }),
            viewportSize: () => ({ width: 1440, height: 900 }),
            addInitScript: async () => {},
            evaluate: async () => {
              if (finishing && invocationState.kind === "metadata")
                throw new Error("literal profiler page metadata unavailable");
              return {
                intervalsMs: [16],
                capped: false,
                longTaskDurationsMs: [],
                longTasksSupported: true,
                theme: "light",
                reducedMotion: true,
                deviceScale: 1,
                hardwareConcurrency: 4,
              };
            },
          });
          const info = {
            outputPath: (...parts: string[]) =>
              path.join(attempt, "profiler", ...parts),
            project: { use: { trace: "off" }, retries: 0 },
            repeatEachIndex: 0,
            attach: async () => {
              if (invocationState.kind === "attachment")
                throw new Error("literal profiler attachment unavailable");
            },
          } as unknown as TestInfo;
          const profile = await createEditorProfiler(
            page as unknown as Page,
            {
              send: async () => ({
                metrics: [{ name: "TaskDuration", value: 1 }],
              }),
            } as unknown as CDPSession,
            info,
            invocationState.project,
            0,
            true,
          );
          if (invocationState.kind !== "missing-build") {
            const bytes =
              invocationState.kind === "mismatched-asset"
                ? Buffer.from("literal different served bytes")
                : fs.readFileSync(invocationState.asset);
            page.emit("response", {
              url: () => "http://127.0.0.1/assets/portable.js",
              ok: () => true,
              body: async () => bytes,
            });
          }
          await profile.measure(
            {
              id: "portable-admission",
              phase: "warm",
              input: "controlled semantic receipt",
            },
            async () => ({
              kind: "existing",
              contract: path.join(attempt, "trial.json"),
            }),
          );
          finishing = true;
          await profile.finish();

          const reportPath = path.join(attempt, "profiler/report.json");
          const report = readJson<Record<string, unknown>>(reportPath)!;
          switch (invocationState.kind) {
            case "missing-status":
              delete report.status;
              break;
            case "malformed-status":
              report.status = { status: "complete" };
              break;
            case "missing-errors":
              delete report.errors;
              break;
            case "malformed-errors":
              report.errors = "";
              break;
            case "nonempty-errors":
              report.errors = ["literal retained profiler error"];
              break;
            case "missing-schema":
              delete report.schemaVersion;
              break;
            case "malformed-schema":
              report.schemaVersion = "1";
              break;
            case "future-schema":
              report.schemaVersion = 2;
              break;
            case "missing-measurement":
              delete report.measurementVersion;
              break;
            case "unknown-measurement":
              report.measurementVersion = "editor-unknown-v99";
              break;
          }
          fs.writeFileSync(reportPath, JSON.stringify(report));

          if (invocationState.launched.length === invocationState.cleanupAt) {
            const { registerE2eCleanupWorkspace } = await vi.importActual<
              typeof import("../e2e/cleanupManifest")
            >("../e2e/cleanupManifest");
            const workspace = fs.mkdtempSync(
              path.join(os.tmpdir(), "sharecut-e2e-portable-cli-"),
            );
            invocationState.cleanupWorkspace = workspace;
            invocationState.cleanupManifest = env.DAW_E2E_CLEANUP_MANIFEST!;
            fs.writeFileSync(
              path.join(workspace, "marker.json"),
              '{"producedTrial":true}\n',
            );
            if (
              !registerE2eCleanupWorkspace(
                workspace,
                invocationState.cleanupManifest,
              )
            )
              throw new Error("Portable cleanup workspace was not admitted");
            const remove = fs.rmSync;
            const removal = vi
              .spyOn(fs, "rmSync")
              .mockImplementation((target, options) => {
                if (String(target) === workspace) {
                  invocationState.removalAttempts++;
                  throw Object.assign(
                    new Error("literal cleanup workspace remained busy"),
                    { code: "EBUSY" },
                  );
                }
                return remove(target, options);
              });
            invocationState.restored.push(() => removal.mockRestore());
            if (invocationState.failLedgerWrite) {
              const write = fs.writeFileSync;
              const writing = vi
                .spyOn(fs, "writeFileSync")
                .mockImplementation((target, data, options) => {
                  if (
                    String(target) ===
                    path.join(invocationState.out, "attempts.json")
                  )
                    throw new Error("literal final attempt ledger unavailable");
                  return write(target, data, options);
                });
              invocationState.restored.push(() => writing.mockRestore());
            }
          }
          return invocationState.kind === "nonzero-runner" ? 23 : 0;
        })(),
        forceKill: async () => {},
        signal: async () => {},
      });
      try {
        return await actual.runE2e(
          args,
          runner,
          undefined,
          async () => ({ port: 37243, release: () => {} }),
          { on: () => () => {}, wait: async () => {} },
        );
      } catch (error) {
        invocationState.rejectedLifecycle = String(error);
        throw error;
      }
    },
  };
});

type Attempt = {
  task: string;
  route: string;
  trial: number;
  semantic?: {
    kind: string;
    result?: TrialAssessment;
    observedDurationMs?: number | null;
  };
  runner?: { kind: string; code?: number; error?: string };
} & Record<string, unknown>;
type RouteSummary = {
  task: string;
  route: string;
  status: string;
  attempted: number;
  valid: number;
  failed: number;
  notRun?: number;
  baselineValid: number;
  duration: { medianMs: number; minMs: number; maxMs: number } | null;
};
export type Summary = {
  selectedProofComplete: boolean;
  attempts: Attempt[];
  routes: RouteSummary[];
};

export const control: {
  readonly repo: string;
  readonly out: string;
  readonly launched: readonly string[];
  readonly rejectedLifecycle: string | null;
  readonly removalAttempts: number;
  readonly cleanupWorkspace: string;
  readonly cleanupManifest: string;
  readonly missingExecutable: string;
} = invocationState;

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const originalEnvironment = { ...process.env };
const temporaryRoots: string[] = [];

export function restoreInvocation() {
  for (const restore of invocationState.restored.reverse()) restore();
  invocationState.restored = [];
  try {
    const retained = originalEnvironment.EDITING_CLI_TEST_RETAIN;
    if (retained) {
      fs.mkdirSync(retained, { recursive: true });
      for (const root of temporaryRoots) {
        const destination = path.join(retained, path.basename(root));
        fs.cpSync(root, destination, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        if (invocationState.cleanupWorkspace)
          fs.cpSync(
            invocationState.cleanupWorkspace,
            path.join(destination, "retained-cleanup-workspace"),
            { recursive: true },
          );
        if (invocationState.cleanupManifest)
          fs.cpSync(
            path.dirname(invocationState.cleanupManifest),
            path.join(destination, "retained-cleanup-manifest"),
            { recursive: true },
          );
      }
    }
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    process.env = { ...originalEnvironment };
    for (const root of temporaryRoots.splice(0))
      fs.rmSync(root, { recursive: true, force: true });
    if (invocationState.cleanupWorkspace)
      fs.rmSync(invocationState.cleanupWorkspace, {
        recursive: true,
        force: true,
      });
    if (invocationState.cleanupManifest)
      fs.rmSync(path.dirname(invocationState.cleanupManifest), {
        recursive: true,
        force: true,
      });
  }
}

export function readJson<T>(file: string): T | null {
  return fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, "utf8")) as T)
    : null;
}

function errorMetadata(error: unknown): unknown {
  if (error === null || typeof error !== "object") return error;
  const fields = [
    "name",
    "message",
    "stack",
    "code",
    "errno",
    "syscall",
    "path",
    "spawnargs",
  ];
  return Object.fromEntries(
    fields.map((field) => [field, Reflect.get(error, field)]),
  );
}

function setup() {
  const web = process.cwd();
  if (!fs.existsSync(path.join(web, "scripts/profile-editing-tasks.ts")))
    throw new Error("Run portable CLI tests from gui/web");
  invocationState.repo = path.resolve(web, "../..");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-editing-cli-"));
  temporaryRoots.push(root);
  const dist = path.join(root, "production-dist");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(dist, "index.html"),
    '<script type="module" src="/assets/portable.js"></script>',
  );
  invocationState.asset = path.join(dist, "assets/portable.js");
  fs.writeFileSync(
    invocationState.asset,
    "export const controlledAdmissionAsset = 1;\n",
  );
  const hash = (bytes: string | Buffer) =>
    createHash("sha256").update(bytes).digest("hex");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: invocationState.repo,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
  const revision = git("rev-parse", "HEAD").trim();
  const exactProductPaths = [
    ".agents/defaults/pipeline.yaml",
    ".agents/defaults/transcript_glossary.yaml",
    "contracts/timeline-zoom.json",
    "contracts/bootstrap-assets.json",
    "gui/web/index.html",
    "gui/web/tsconfig.json",
    "gui/web/tsconfig.app.json",
    "gui/web/tsconfig.node.json",
    "gui/web/tsconfig.e2e.json",
    "gui/web/scripts/build-app.ts",
    "gui/web/scripts/check-bundle-no-e2e.ts",
    "gui/web/scripts/check-bundle-no-stories.ts",
    "gui/web/package.json",
    "gui/web/package-lock.json",
    "gui/web/vite.config.ts",
    "pyproject.toml",
    "uv.lock",
  ];
  const files = git("ls-tree", "-rz", "--name-only", revision)
    .split("\0")
    .filter(
      (file) =>
        file.startsWith("src/podcast_mcp/") ||
        file.startsWith("gui/web/src/") ||
        file.startsWith("gui/web/public/") ||
        exactProductPaths.includes(file),
    );
  const productFiles = Object.fromEntries(
    files.map((file) => {
      const disk = path.join(invocationState.repo, file);
      return [
        file,
        hash(
          fs.lstatSync(disk).isSymbolicLink()
            ? fs.readlinkSync(disk)
            : fs.readFileSync(disk),
        ),
      ];
    }),
  );
  const assets = Object.fromEntries(
    ["index.html", "assets/portable.js"].map((file) => [
      file,
      hash(fs.readFileSync(path.join(dist, file))),
    ]),
  );
  const build = path.join(root, "build.json");
  const source = path.join(root, "source.json");
  fs.writeFileSync(
    build,
    JSON.stringify({
      command: ["npm", "run", "build"],
      exit: 0,
      productRevision: revision,
      buildEnvironment: { nodeEnv: "production", viteSharecutE2e: null },
      assets,
    }),
  );
  fs.writeFileSync(
    source,
    JSON.stringify({ productRevision: revision, productFiles }),
  );
  const task = editingTaskRegistry.find((row) => row.id === "trim")!;
  invocationState.project = path.join(root, "episode.project.json");
  fs.writeFileSync(
    invocationState.project,
    JSON.stringify({
      meta: { name: "Portable admission fixture", workspace_dir: root },
      timeline: {
        duration_sec: task.start.duration_sec,
        tracks: task.start.tracks,
        clips: task.start.clips,
      },
      transcripts: { combined: { utterances: [] }, per_track: [] },
    }),
  );
  return { root, revision, dist, build, source };
}

function capturedProcessResult(): ReturnType<
  ActualChildProcess["spawnSync"]
> | null {
  return invocationState.processResult;
}

export async function invoke(
  kind: ProfileFault,
  options: {
    trials?: number;
    cleanupAt?: number;
    failLedgerWrite?: boolean;
    processFault?: ProcessFault;
  } = {},
) {
  const fixture = setup();
  invocationState.kind = kind;
  invocationState.out = path.join(fixture.root, "output");
  invocationState.cleanupAt = options.cleanupAt ?? 0;
  invocationState.failLedgerWrite = options.failLedgerWrite ?? false;
  invocationState.launched = [];
  invocationState.cleanupWorkspace = "";
  invocationState.cleanupManifest = "";
  invocationState.rejectedLifecycle = null;
  invocationState.removalAttempts = 0;
  invocationState.backendCalls = [];
  invocationState.processFault = options.processFault ?? null;
  invocationState.processResult = null;
  invocationState.missingExecutable = path.join(
    fixture.root,
    "absent-process-executable",
  );
  invocationState.buildCalls = [];
  if (invocationState.processFault?.phase === "build")
    process.env.VITE_SHARECUT_E2E = "literal inherited E2E flag";
  process.exitCode = undefined;
  process.argv = [
    process.execPath,
    "scripts/profile-editing-tasks.ts",
    "--app-base",
    fixture.revision,
    "--trials",
    String(options.trials ?? 5),
    "--task",
    "trim",
    "--route",
    "handle-keyboard",
    ...(invocationState.processFault?.phase === "build"
      ? []
      : [
          "--production-dist",
          fixture.dist,
          "--build-receipt",
          fixture.build,
          "--source-receipt",
          fixture.source,
        ]),
    "--out",
    invocationState.out,
  ];
  vi.resetModules();
  let rejection: string | null = null;
  let caughtError: unknown = null;
  try {
    await import("./profile-editing-tasks.ts");
  } catch (error) {
    rejection = String(error);
    caughtError = error;
  }
  for (const restore of invocationState.restored.reverse()) restore();
  invocationState.restored = [];
  const backendCalls = invocationState.backendCalls.map((call) => ({
    ...call,
    argv: [...call.argv] as BackendCall["argv"],
  }));
  const buildCalls = invocationState.buildCalls.map((call) => ({
    ...call,
    argv: [...call.argv] as BuildCall["argv"],
  }));
  const processResult = capturedProcessResult();
  fs.writeFileSync(
    path.join(fixture.root, "test-invocation.json"),
    JSON.stringify(
      {
        argv: process.argv,
        rejection,
        caughtError: errorMetadata(caughtError),
        cause: errorMetadata(
          caughtError !== null && typeof caughtError === "object"
            ? Reflect.get(caughtError, "cause")
            : null,
        ),
        processFault: invocationState.processFault,
        processResult: processResult
          ? { ...processResult, error: errorMetadata(processResult.error) }
          : null,
        missingExecutable: invocationState.missingExecutable,
        backendCalls,
        buildCalls,
        processExitCode: process.exitCode ?? null,
        launched: invocationState.launched,
        rejectedLifecycle: invocationState.rejectedLifecycle,
        cleanupWorkspace: invocationState.cleanupWorkspace,
        cleanupManifest: invocationState.cleanupManifest,
        removalAttempts: invocationState.removalAttempts,
        semantics:
          "existing trial helper adapted to current registry states and assessed by canonical consumer",
        boundaries:
          "controlled runner, page, signal, lease, exact backend import subprocess, targeted removal and optional final ledger write",
        timingUse:
          "five controlled receipts exercise admission only, not independent performance measurements",
      },
      null,
      2,
    ),
  );
  const summary = readJson<Summary>(
    path.join(invocationState.out, "summary.json"),
  );
  const attempts = readJson<Attempt[]>(
    path.join(invocationState.out, "attempts.json"),
  );
  const selected = summary?.routes.find(
    (row) => row.task === "trim" && row.route === "handle-keyboard",
  );
  expect(backendCalls).toEqual(
    (options.trials ?? 5) < 5
      ? []
      : [
          {
            command: "uv",
            argv: [
              "run",
              "python",
              "-c",
              "import json,os,sys,podcast_mcp.gui.server; print(json.dumps({'cwd':os.getcwd(),'executable':sys.executable,'module':podcast_mcp.gui.server.__file__}))",
            ],
            cwd: invocationState.repo,
            encoding: "utf8",
          },
        ],
  );
  expect(buildCalls).toEqual(
    invocationState.processFault?.phase === "build"
      ? [
          {
            command: "npm",
            argv: ["run", "build"],
            encoding: "utf8",
            nodeEnv: "production",
            viteSharecutE2e: null,
          },
        ]
      : [],
  );
  return {
    rejection,
    caughtError,
    summary,
    attempts,
    selected,
    backendCalls,
    buildCalls,
    processResult,
  };
}
