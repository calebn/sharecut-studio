import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CDPSession, Page, TestInfo } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
import { editingTaskRegistry } from "../e2e/editingTaskCases";
import {
  assessEditingTrial,
  type EditingTrial,
  type TrialAssessment,
} from "../e2e/editingTaskReport";
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

const control = vi.hoisted(() => ({
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
        result = actual.spawnSync(control.missingExecutable, [], {
          cwd: control.repo,
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
          { cwd: control.repo, encoding: "utf8" },
        );
        break;
      case "signal":
        result = actual.spawnSync(
          process.execPath,
          [
            "-e",
            'process.stderr.write("literal process signal failure\\n", () => process.kill(process.pid, "SIGTERM"));',
          ],
          { cwd: control.repo, encoding: "utf8" },
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
    control.processResult = result;
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
      options?.cwd === control.repo &&
      options.encoding === "utf8"
    ) {
      control.backendCalls.push({
        command,
        argv: [...argv] as BackendCall["argv"],
        cwd: options.cwd,
        encoding: options.encoding,
      });
      const module = path.join(control.repo, "src/podcast_mcp/gui/server.py");
      fs.readFileSync(module);
      const stdout = `${JSON.stringify({
        cwd: control.repo,
        executable: "controlled-backend-import-boundary",
        module,
      })}\n`;
      if (control.processFault?.phase === "backend")
        return faultResult(control.processFault, stdout);
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
      control.processFault?.phase === "build" &&
      command === "npm" &&
      Array.isArray(argv) &&
      JSON.stringify(argv) === JSON.stringify(["run", "build"]) &&
      options?.encoding === "utf8" &&
      options.env?.NODE_ENV === "production" &&
      !Object.hasOwn(options.env, "VITE_SHARECUT_E2E")
    ) {
      control.buildCalls.push({
        command,
        argv: [...argv] as BuildCall["argv"],
        encoding: options.encoding,
        nodeEnv: options.env.NODE_ENV,
        viteSharecutE2e: null,
      });
      return faultResult(control.processFault, "");
    }
    return actual.spawnSync(...args);
  };
  return {
    ...actual,
    spawnSync,
    default: { ...actual.default, spawnSync },
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
          control.launched.push(attempt);
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
          if (control.kind === "nonfinite-duration")
            semantic.durationMs = Infinity;
          if (control.kind === "mismatched-task") semantic.task = "range-cut";
          if (control.kind === "mismatched-route")
            semantic.route = "handle-pointer";
          if (control.kind === "failed-semantics") {
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
              if (finishing && control.kind === "metadata")
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
              if (control.kind === "attachment")
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
            control.project,
            0,
            true,
          );
          if (control.kind !== "missing-build") {
            const bytes =
              control.kind === "mismatched-asset"
                ? Buffer.from("literal different served bytes")
                : fs.readFileSync(control.asset);
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
          switch (control.kind) {
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

          if (control.launched.length === control.cleanupAt) {
            const { registerE2eCleanupWorkspace } = await vi.importActual<
              typeof import("../e2e/cleanupManifest")
            >("../e2e/cleanupManifest");
            const workspace = fs.mkdtempSync(
              path.join(os.tmpdir(), "sharecut-e2e-portable-cli-"),
            );
            control.cleanupWorkspace = workspace;
            control.cleanupManifest = env.DAW_E2E_CLEANUP_MANIFEST!;
            fs.writeFileSync(
              path.join(workspace, "marker.json"),
              '{"producedTrial":true}\n',
            );
            if (
              !registerE2eCleanupWorkspace(workspace, control.cleanupManifest)
            )
              throw new Error("Portable cleanup workspace was not admitted");
            const remove = fs.rmSync;
            const removal = vi
              .spyOn(fs, "rmSync")
              .mockImplementation((target, options) => {
                if (String(target) === workspace) {
                  control.removalAttempts++;
                  throw Object.assign(
                    new Error("literal cleanup workspace remained busy"),
                    { code: "EBUSY" },
                  );
                }
                return remove(target, options);
              });
            control.restored.push(() => removal.mockRestore());
            if (control.failLedgerWrite) {
              const write = fs.writeFileSync;
              const writing = vi
                .spyOn(fs, "writeFileSync")
                .mockImplementation((target, data, options) => {
                  if (
                    String(target) === path.join(control.out, "attempts.json")
                  )
                    throw new Error("literal final attempt ledger unavailable");
                  return write(target, data, options);
                });
              control.restored.push(() => writing.mockRestore());
            }
          }
          return control.kind === "nonzero-runner" ? 23 : 0;
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
        control.rejectedLifecycle = String(error);
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
type Summary = {
  selectedProofComplete: boolean;
  attempts: Attempt[];
  routes: RouteSummary[];
};

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const originalEnvironment = { ...process.env };
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const restore of control.restored.reverse()) restore();
  control.restored = [];
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
      if (control.cleanupWorkspace)
        fs.cpSync(
          control.cleanupWorkspace,
          path.join(destination, "retained-cleanup-workspace"),
          { recursive: true },
        );
      if (control.cleanupManifest)
        fs.cpSync(
          path.dirname(control.cleanupManifest),
          path.join(destination, "retained-cleanup-manifest"),
          { recursive: true },
        );
    }
  }
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  process.env = { ...originalEnvironment };
  for (const root of temporaryRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  if (control.cleanupWorkspace)
    fs.rmSync(control.cleanupWorkspace, { recursive: true, force: true });
  if (control.cleanupManifest)
    fs.rmSync(path.dirname(control.cleanupManifest), {
      recursive: true,
      force: true,
    });
});

function readJson<T>(file: string): T | null {
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
  control.repo = path.resolve(web, "../..");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-editing-cli-"));
  temporaryRoots.push(root);
  const dist = path.join(root, "production-dist");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(dist, "index.html"),
    '<script type="module" src="/assets/portable.js"></script>',
  );
  control.asset = path.join(dist, "assets/portable.js");
  fs.writeFileSync(
    control.asset,
    "export const controlledAdmissionAsset = 1;\n",
  );
  const hash = (bytes: string | Buffer) =>
    createHash("sha256").update(bytes).digest("hex");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: control.repo,
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
      const disk = path.join(control.repo, file);
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
  control.project = path.join(root, "episode.project.json");
  fs.writeFileSync(
    control.project,
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

async function invoke(
  kind: ProfileFault,
  options: {
    trials?: number;
    cleanupAt?: number;
    failLedgerWrite?: boolean;
    processFault?: ProcessFault;
  } = {},
) {
  const fixture = setup();
  control.kind = kind;
  control.out = path.join(fixture.root, "output");
  control.cleanupAt = options.cleanupAt ?? 0;
  control.failLedgerWrite = options.failLedgerWrite ?? false;
  control.launched = [];
  control.cleanupWorkspace = "";
  control.cleanupManifest = "";
  control.rejectedLifecycle = null;
  control.removalAttempts = 0;
  control.backendCalls = [];
  control.processFault = options.processFault ?? null;
  control.processResult = null;
  control.missingExecutable = path.join(
    fixture.root,
    "absent-process-executable",
  );
  control.buildCalls = [];
  if (control.processFault?.phase === "build")
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
    ...(control.processFault?.phase === "build"
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
    control.out,
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
  for (const restore of control.restored.reverse()) restore();
  control.restored = [];
  const backendCalls = control.backendCalls.map((call) => ({
    ...call,
    argv: [...call.argv] as BackendCall["argv"],
  }));
  const buildCalls = control.buildCalls.map((call) => ({
    ...call,
    argv: [...call.argv] as BuildCall["argv"],
  }));
  const processResult = control.processResult;
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
        processFault: control.processFault,
        processResult: processResult
          ? { ...processResult, error: errorMetadata(processResult.error) }
          : null,
        missingExecutable: control.missingExecutable,
        backendCalls,
        buildCalls,
        processExitCode: process.exitCode ?? null,
        launched: control.launched,
        rejectedLifecycle: control.rejectedLifecycle,
        cleanupWorkspace: control.cleanupWorkspace,
        cleanupManifest: control.cleanupManifest,
        removalAttempts: control.removalAttempts,
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
  const summary = readJson<Summary>(path.join(control.out, "summary.json"));
  const attempts = readJson<Attempt[]>(path.join(control.out, "attempts.json"));
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
            cwd: control.repo,
            encoding: "utf8",
          },
        ],
  );
  expect(buildCalls).toEqual(
    control.processFault?.phase === "build"
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

const passingSemantics = {
  status: "pass",
  completedWork: 1,
  mutations: 1,
  accidentalCommands: 0,
  observations: { save: "pass", cancel: "pass", undo: "pass" },
};

it("admits five complete canonical profiles with matching served bytes and real assessed semantics", async () => {
  const { rejection, summary, selected, backendCalls } =
    await invoke("complete");
  expect(backendCalls).toHaveLength(1);
  expect(readJson(path.join(control.out, "backend-import.log"))).toEqual({
    cwd: control.repo,
    executable: "controlled-backend-import-boundary",
    module: path.join(control.repo, "src/podcast_mcp/gui/server.py"),
  });
  expect(readJson(path.join(control.out, "protocol.json"))).toMatchObject({
    backend: { executable: "controlled-backend-import-boundary" },
  });
  expect({
    rejection,
    exitCode: process.exitCode,
    complete: summary?.selectedProofComplete,
  }).toEqual({
    rejection: null,
    exitCode: 0,
    complete: true,
  });
  expect(selected).toMatchObject({
    status: "pass",
    attempted: 5,
    valid: 5,
    failed: 0,
    baselineValid: 5,
    duration: { medianMs: 10, minMs: 10, maxMs: 10 },
  });
  expect(summary?.attempts).toHaveLength(5);
  for (const attempt of control.launched) {
    expect(
      assessEditingTrial(
        editingTaskRegistry.find((row) => row.id === "trim")!,
        readJson<EditingTrial>(path.join(attempt, "trial.json"))!,
      ),
    ).toMatchObject(passingSemantics);
    expect(readJson(path.join(attempt, "profiler/report.json"))).toMatchObject({
      schemaVersion: 1,
      measurementVersion: "editor-response-v1",
      status: "complete",
      errors: [],
      environment: {
        build: {
          status: "measured",
          value: { mode: "production", e2eHooks: false },
        },
      },
      samples: [{ result: { status: "completed" } }],
    });
  }
  for (const row of summary!.attempts) {
    expect(row.semantic).toMatchObject({
      kind: "assessed",
      result: passingSemantics,
      observedDurationMs: 10,
    });
    expect(row.runner).toEqual({ kind: "returned", code: 0 });
  }
}, 120000);

it.each([
  {
    kind: "metadata" as const,
    error: "metadata: Error: literal profiler page metadata unavailable",
  },
  {
    kind: "attachment" as const,
    error:
      "attachment retention: Error: literal profiler attachment unavailable",
  },
])(
  "excludes canonical $kind failure while retaining passing semantic observations",
  async ({ kind, error }) => {
    const { rejection, summary, selected } = await invoke(kind);
    for (const attempt of control.launched) {
      expect(
        readJson(path.join(attempt, "profiler/report.json")),
      ).toMatchObject({
        status: "incomplete",
        errors: [error],
        environment: { build: { status: "measured" } },
        samples: [{ result: { status: "completed" } }],
      });
    }
    expect({
      rejection,
      exitCode: process.exitCode,
      complete: summary?.selectedProofComplete,
    }).toEqual({
      rejection: null,
      exitCode: 1,
      complete: false,
    });
    expect(selected).toMatchObject({
      status: "fail",
      attempted: 5,
      valid: 0,
      failed: 5,
      baselineValid: 0,
      duration: null,
    });
    expect(summary?.attempts).toHaveLength(5);
    for (const row of summary!.attempts)
      expect(row.semantic).toMatchObject({
        kind: "assessed",
        result: passingSemantics,
      });
  },
  120000,
);

it.each([
  "missing-status",
  "malformed-status",
  "missing-errors",
  "malformed-errors",
  "nonempty-errors",
  "missing-schema",
  "malformed-schema",
  "future-schema",
  "missing-measurement",
  "unknown-measurement",
  "missing-build",
  "mismatched-asset",
] as const)(
  "rejects %s profiler receipt through actual CLI admission",
  async (kind) => {
    const { rejection, summary, selected } = await invoke(kind);
    expect({
      rejection,
      exitCode: process.exitCode,
      complete: summary?.selectedProofComplete,
    }).toEqual({
      rejection: null,
      exitCode: 1,
      complete: false,
    });
    expect(selected).toMatchObject({
      status: "fail",
      attempted: 5,
      valid: 0,
      failed: 5,
      baselineValid: 0,
      duration: null,
    });
    expect(summary?.attempts).toHaveLength(5);
    for (const row of summary!.attempts)
      expect(row.semantic).toMatchObject({
        kind: "assessed",
        result: passingSemantics,
      });
  },
  120000,
);

it.each(["nonfinite-duration", "failed-semantics"] as const)(
  "excludes %s even with a complete canonical profile",
  async (kind) => {
    const { summary, selected } = await invoke(kind);
    expect(process.exitCode).toBe(1);
    expect(summary?.selectedProofComplete).toBe(false);
    expect(selected).toMatchObject({
      status: "fail",
      attempted: 5,
      valid: 0,
      failed: 5,
      baselineValid: 0,
      duration: null,
    });
    expect(summary?.attempts).toHaveLength(5);
    if (kind === "nonfinite-duration") {
      for (const row of summary!.attempts) {
        expect(row.semantic?.result).toMatchObject({
          status: "fail",
          observations: passingSemantics.observations,
          reasons: expect.arrayContaining([
            "elapsed duration is missing, non-finite or negative",
          ]),
        });
      }
    } else {
      for (const row of summary!.attempts) {
        expect(row.semantic?.result).toMatchObject({
          status: "fail",
          completedWork: 0,
          observations: { save: "fail", cancel: "pass", undo: "fail" },
          reasons: expect.arrayContaining(["literal saved-action failure"]),
        });
      }
    }
    for (const attempt of control.launched)
      expect(
        readJson(path.join(attempt, "profiler/report.json")),
      ).toMatchObject({ status: "complete", errors: [] });
  },
  120000,
);

it("preserves the five-trial baseline threshold at the actual CLI parser", async () => {
  const { rejection, backendCalls } = await invoke("complete", { trials: 4 });
  expect(backendCalls).toEqual([]);
  expect(rejection).toBe(
    "Error: Use --app-base SHA --trials N --out NEW_DIRECTORY; baseline requires at least five trials",
  );
  expect(control.launched).toEqual([]);
});

it.each(["mismatched-task", "mismatched-route"] as const)(
  "rejects %s at the scheduled receipt boundary despite readable passing semantics",
  async (kind) => {
    const { summary, selected } = await invoke(kind);
    const task = editingTaskRegistry.find((row) => row.id === "trim")!;
    for (const attempt of control.launched) {
      const raw = readJson<EditingTrial>(path.join(attempt, "trial.json"))!;
      expect({ task: raw.task, route: raw.route }).toEqual(
        kind === "mismatched-task"
          ? { task: "range-cut", route: "handle-keyboard" }
          : { task: "trim", route: "handle-pointer" },
      );
      expect(assessEditingTrial(task, raw)).toMatchObject(passingSemantics);
    }
    expect(control.launched).toHaveLength(5);
    expect(process.exitCode).toBe(1);
    expect(summary?.selectedProofComplete).toBe(false);
    expect(selected).toMatchObject({
      status: "fail",
      attempted: 5,
      valid: 0,
      failed: 5,
      baselineValid: 0,
      duration: null,
    });
  },
  120000,
);

it("excludes a settled nonzero runner exit while retaining passing semantics and a complete profile", async () => {
  const { summary, selected } = await invoke("nonzero-runner");
  expect(process.exitCode).toBe(1);
  expect(summary?.selectedProofComplete).toBe(false);
  expect(selected).toMatchObject({
    status: "fail",
    attempted: 5,
    valid: 0,
    failed: 5,
    baselineValid: 0,
    duration: null,
  });
  expect(summary?.attempts).toHaveLength(5);
  for (const row of summary!.attempts) {
    expect(row.runner).toEqual({ kind: "returned", code: 23 });
    expect(row.semantic).toMatchObject({
      kind: "assessed",
      result: passingSemantics,
    });
  }
  for (const attempt of control.launched)
    expect(readJson(path.join(attempt, "profiler/report.json"))).toMatchObject({
      status: "complete",
      errors: [],
    });
}, 120000);

function expectCleanupEvidence() {
  expect(control.rejectedLifecycle).toBe(
    "Error: literal cleanup workspace remained busy",
  );
  expect(control.removalAttempts).toBe(5);
  expect(
    fs.readFileSync(path.join(control.cleanupWorkspace, "marker.json"), "utf8"),
  ).toBe('{"producedTrial":true}\n');
  expect(readJson(control.cleanupManifest)).toEqual({
    workspaces: [control.cleanupWorkspace],
  });
  const attempt = control.launched.at(-1)!;
  const retained = readJson<EditingTrial>(path.join(attempt, "trial.json"))!;
  const task = editingTaskRegistry.find((row) => row.id === "trim")!;
  expect(assessEditingTrial(task, retained)).toMatchObject(passingSemantics);
  expect(readJson(path.join(attempt, "profiler/report.json"))).toMatchObject({
    status: "complete",
    errors: [],
  });
}

function expectStoppedCensus(summary: Summary | null, cleanupAt: number) {
  expect(summary?.selectedProofComplete).toBe(false);
  const route = summary?.routes.find(
    (row) => row.task === "trim" && row.route === "handle-keyboard",
  );
  expect(route).toMatchObject({
    status: "fail",
    attempted: cleanupAt,
    failed: 1,
    notRun: 5 - cleanupAt,
    valid: cleanupAt - 1,
    baselineValid: cleanupAt - 1,
    duration: null,
  });
  expect(
    summary?.attempts.map((row) => ({
      task: row.task,
      route: row.route,
      trial: row.trial,
    })),
  ).toEqual(
    [1, 2, 3, 4, 5].map((trial) => ({
      task: "trim",
      route: "handle-keyboard",
      trial,
    })),
  );
  const failed = summary!.attempts[cleanupAt - 1]!;
  expect(failed.runner).toEqual({
    kind: "rejected",
    error: "Error: literal cleanup workspace remained busy",
  });
  expect(failed).not.toHaveProperty("code");
  expect(JSON.stringify(failed)).toContain(
    "literal cleanup workspace remained busy",
  );
  expect(failed.semantic).toMatchObject({
    kind: "assessed",
    result: passingSemantics,
  });
  for (const row of summary!.attempts.slice(cleanupAt)) {
    expect(row).not.toHaveProperty("runner");
    expect(row).not.toHaveProperty("code");
    expect(JSON.stringify(row)).toMatch(/stop|cleanup|lifecycle/i);
  }
  for (const trial of [1, 2, 3, 4, 5]) {
    expect(
      readJson(
        path.join(control.out, `trim-handle-keyboard-${trial}`, "status.json"),
      ),
    ).toMatchObject({
      task: "trim",
      route: "handle-keyboard",
      trial,
      status:
        trial < cleanupAt ? "pass" : trial === cleanupAt ? "fail" : "not-run",
    });
  }
}

it.each([1, 3])(
  "retains the whole five-slot schedule when real cleanup rejects on attempt %s",
  async (cleanupAt) => {
    const { summary, attempts } = await invoke("complete", { cleanupAt });
    expectCleanupEvidence();
    expect(process.exitCode).toBe(1);
    expect(control.launched).toHaveLength(cleanupAt);
    expectStoppedCensus(summary, cleanupAt);
    expect(attempts).toEqual(summary!.attempts);
  },
  120000,
);

it("still writes the final summary and truthful statuses when final ledger retention also fails", async () => {
  const { rejection, summary, attempts } = await invoke("complete", {
    cleanupAt: 1,
    failLedgerWrite: true,
  });
  expectCleanupEvidence();
  expect(process.exitCode).toBe(1);
  expect(control.launched).toHaveLength(1);
  expectStoppedCensus(summary, 1);
  expect(
    attempts?.map((row) => ({
      task: row.task,
      route: row.route,
      trial: row.trial,
      kind: row.kind,
    })),
  ).toEqual(
    [1, 2, 3, 4, 5].map((trial) => ({
      task: "trim",
      route: "handle-keyboard",
      trial,
      kind: "not-run",
    })),
  );
  for (const row of attempts!) {
    expect(row).not.toHaveProperty("runner");
    expect(row).not.toHaveProperty("semantic");
  }
  expect(JSON.stringify({ rejection, summary })).toContain(
    "literal final attempt ledger unavailable",
  );
}, 120000);

const processPhases = [
  {
    phase: "backend",
    diagnostic: "Backend import provenance",
    command: "uv run python -c",
  },
  {
    phase: "build",
    diagnostic: "Production build",
    command: "npm run build",
  },
] as const;

function expectRejectedBeforeAdmission(
  result: Awaited<ReturnType<typeof invoke>>,
  phase: "backend" | "build",
  retainedBackendText = false,
) {
  expect(result.summary).toBe(null);
  expect(result.attempts).toBe(null);
  expect(control.launched).toEqual([]);
  expect(fs.existsSync(path.join(control.out, "protocol.json"))).toBe(false);
  expect(fs.existsSync(path.join(control.out, "protocol.sha256"))).toBe(false);
  expect(fs.existsSync(path.join(control.out, "build.json"))).toBe(false);
  expect(fs.existsSync(path.join(control.out, "production-dist"))).toBe(false);
  expect(fs.existsSync(path.join(control.out, "production-build.log"))).toBe(
    false,
  );
  if (phase === "backend")
    expect(fs.existsSync(path.join(control.out, "backend-import.log"))).toBe(
      retainedBackendText,
    );
  else
    expect(readJson(path.join(control.out, "backend-import.log"))).toEqual({
      cwd: control.repo,
      executable: "controlled-backend-import-boundary",
      module: path.join(control.repo, "src/podcast_mcp/gui/server.py"),
    });
}

it.each(processPhases)(
  "retains the actual ENOENT cause for $phase spawn failure before log retention",
  async ({ phase, diagnostic, command }) => {
    const result = await invoke("complete", {
      processFault: { phase, kind: "spawn-error" },
    });
    expect(result.processResult).toMatchObject({
      status: null,
      signal: null,
      error: { code: "ENOENT", path: control.missingExecutable, spawnargs: [] },
    });
    expect(result.processResult!.stdout).toBeUndefined();
    expect(result.processResult!.stderr).toBeUndefined();
    expect(result.rejection).toContain(diagnostic);
    expect(result.rejection).toContain(command);
    expect(result.rejection).toContain("ENOENT");
    expect(result.caughtError).toBeInstanceOf(Error);
    expect((result.caughtError as Error).cause).toBe(
      result.processResult!.error,
    );
    expectRejectedBeforeAdmission(result, phase);
  },
  120000,
);

it.each(processPhases)(
  "retains native status 23 and literal stderr for $phase failure before log retention",
  async ({ phase, diagnostic, command }) => {
    const result = await invoke("complete", {
      processFault: { phase, kind: "nonzero" },
    });
    expect(result.rejection).toContain(diagnostic);
    expect(result.rejection).toContain(command);
    expect(result.rejection).toMatch(/status\s*[:=]?\s*23/i);
    expect(result.rejection).toContain("literal process boundary failure");
    expect(result.processResult).toMatchObject({
      status: 23,
      signal: null,
      stdout: "",
      stderr: "literal process boundary failure\n",
    });
    expect(result.processResult!.error).toBeUndefined();
    expectRejectedBeforeAdmission(result, phase);
  },
  120000,
);

it.each(processPhases)(
  "retains native SIGTERM and literal stderr for $phase failure before log retention",
  async ({ phase, diagnostic, command }) => {
    const result = await invoke("complete", {
      processFault: { phase, kind: "signal" },
    });
    expect(result.rejection).toContain(diagnostic);
    expect(result.rejection).toContain(command);
    expect(result.rejection).toContain("SIGTERM");
    expect(result.rejection).toMatch(/status\s*[:=]?\s*null/i);
    expect(result.rejection).toContain("literal process signal failure");
    expect(result.processResult).toMatchObject({
      status: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "literal process signal failure\n",
    });
    expect(result.processResult!.error).toBeUndefined();
    expectRejectedBeforeAdmission(result, phase);
  },
  120000,
);

it.each(processPhases)(
  "rejects missing UTF8 stdout from nominal $phase success before log retention",
  async ({ phase, diagnostic, command }) => {
    const result = await invoke("complete", {
      processFault: { phase, kind: "missing-stdout" },
    });
    expect(result.rejection).toContain(diagnostic);
    expect(result.rejection).toContain(command);
    expect(result.rejection).toContain("expected UTF8 stdout/stderr");
    expect(result.processResult).toMatchObject({
      status: 0,
      signal: null,
      stdout: null,
      stderr: "",
    });
    expectRejectedBeforeAdmission(result, phase);
  },
  120000,
);

it.each(processPhases)(
  "rejects missing UTF8 stderr from nominal $phase success before log retention",
  async ({ phase, diagnostic, command }) => {
    const result = await invoke("complete", {
      processFault: { phase, kind: "missing-stderr" },
    });
    expect(result.rejection).toContain(diagnostic);
    expect(result.rejection).toContain(command);
    expect(result.rejection).toContain("expected UTF8 stdout/stderr");
    expect(result.processResult).toMatchObject({
      status: 0,
      signal: null,
      stderr: null,
    });
    expect(typeof result.processResult!.stdout).toBe("string");
    expectRejectedBeforeAdmission(result, phase);
  },
  120000,
);

it("rejects invalid backend JSON through the actual producer parser and retains the text log", async () => {
  const result = await invoke("complete", {
    processFault: { phase: "backend", kind: "invalid-json" },
  });
  expect(result.caughtError).toBeInstanceOf(SyntaxError);
  expect(result.rejection).toMatch(/SyntaxError:.*JSON/i);
  expect(
    fs.readFileSync(path.join(control.out, "backend-import.log"), "utf8"),
  ).toBe("literal invalid JSON\n");
  expectRejectedBeforeAdmission(result, "backend", true);
}, 120000);

it.each([
  { label: "null record", metadata: () => null },
  { label: "array record", metadata: () => [] },
  {
    label: "nontext cwd",
    metadata: (repo: string) => ({
      cwd: 23,
      executable: "literal executable",
      module: path.join(repo, "src/podcast_mcp/gui/server.py"),
    }),
  },
  {
    label: "missing executable",
    metadata: (repo: string) => ({
      cwd: repo,
      module: path.join(repo, "src/podcast_mcp/gui/server.py"),
    }),
  },
  {
    label: "empty executable",
    metadata: (repo: string) => ({
      cwd: repo,
      executable: "",
      module: path.join(repo, "src/podcast_mcp/gui/server.py"),
    }),
  },
  {
    label: "nontext module",
    metadata: (repo: string) => ({
      cwd: repo,
      executable: "literal executable",
      module: null,
    }),
  },
])(
  "rejects backend $label as invalid metadata before protocol admission",
  async ({ metadata }) => {
    const repo = path.resolve(process.cwd(), "../..");
    const record = metadata(repo);
    const result = await invoke("complete", {
      processFault: {
        phase: "backend",
        kind: "invalid-metadata",
        metadata: record,
      },
    });
    expect(result.rejection).toContain(
      "Backend import provenance returned invalid metadata",
    );
    expect(
      fs.readFileSync(path.join(control.out, "backend-import.log"), "utf8"),
    ).toBe(`${JSON.stringify(record)}\n`);
    expectRejectedBeforeAdmission(result, "backend", true);
  },
  120000,
);
