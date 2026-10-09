import {
  execFileSync,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { editingTaskRegistry } from "../e2e/editingTaskCases";
import { verifyEditingDistribution } from "../e2e/editingTaskEvidence";
import {
  assessEditingTrial,
  type EditingSummaryAttempt,
  type EditingTrial,
  summarizeEditingAttempts,
} from "../e2e/editingTaskReport";
import { acquireE2ePortLease } from "../e2e/port";
import { runE2e } from "../e2e/runE2e";

const { values } = parseArgs({
  options: {
    "app-base": { type: "string" },
    trials: { type: "string", default: "5" },
    out: { type: "string" },
    task: { type: "string" },
    route: { type: "string" },
    "production-dist": { type: "string" },
    "build-receipt": { type: "string" },
    "source-receipt": { type: "string" },
    "validity-only": { type: "boolean", default: false },
    diagnostic: { type: "boolean", default: false },
  },
});
if (
  !values.out ||
  !values["app-base"] ||
  !/^\d+$/.test(values.trials!) ||
  Number(values.trials) < 1 ||
  (!values["validity-only"] && !values.diagnostic && Number(values.trials) < 5)
)
  throw new Error(
    "Use --app-base SHA --trials N --out NEW_DIRECTORY; baseline requires at least five trials",
  );
if (values.task && !editingTaskRegistry.some((task) => task.id === values.task))
  throw new Error("Unknown task");
const tasks = editingTaskRegistry.filter(
  (task) => !values.task || task.id === values.task,
);
const selectedRoutes = values.route?.split(",");
if (
  selectedRoutes &&
  !selectedRoutes.every((id) =>
    tasks.some((task) =>
      task.routes.some((route) => route.id === id && !("pending" in route)),
    ),
  )
)
  throw new Error("Unknown or pending route");
const output = path.resolve(values.out);
if (fs.existsSync(output))
  throw new Error(`Refusing to overwrite retained evidence ${output}`);
fs.mkdirSync(output, { recursive: true });
const repo = path.resolve("../..");
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const gitPaths = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
const hash = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const mediaDir = path.join(output, "replay-media");
fs.mkdirSync(mediaDir);
const replayMedia = Object.fromEntries(
  ["reference", "guest"].map((id) => {
    const relativePath = `raw/${id}.wav`;
    const sourcePath = path.join(
      repo,
      "tests/fixtures/aligned_dialogue",
      relativePath,
    );
    const retainedPath = path.join(mediaDir, `${id}.wav`);
    const sha256 = hash(fs.readFileSync(sourcePath));
    fs.copyFileSync(sourcePath, retainedPath);
    if (hash(fs.readFileSync(retainedPath)) !== sha256)
      throw new Error(`Retained replay media differs for ${id}`);
    return [id, { relativePath, sourcePath, retainedPath, sha256 }];
  }),
);
const replayReceipt = path.join(output, "replay-media.json");
fs.writeFileSync(replayReceipt, JSON.stringify(replayMedia, null, 2));
const appBase = git("rev-parse", `${values["app-base"]}^{commit}`);
const driverSha = git("rev-parse", "HEAD");
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
const isProductPath = (file: string) =>
  file.startsWith("src/podcast_mcp/") ||
  file.startsWith("gui/web/src/") ||
  file.startsWith("gui/web/public/") ||
  exactProductPaths.includes(file);
const productPaths = gitPaths("ls-tree", "-rz", "--name-only", appBase).filter(
  isProductPath,
);
const additions = [
  ...gitPaths("ls-files", "-z"),
  ...gitPaths("ls-files", "--others", "--exclude-standard", "-z"),
  ...gitPaths(
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
    "--",
    "gui/web/src/",
    "gui/web/public/",
    ...exactProductPaths,
  ),
].filter((file) => isProductPath(file) && !productPaths.includes(file));
if (additions.length)
  throw new Error(
    `App source paths absent from app-base ${additions.join(", ")}`,
  );
const productFiles: Record<string, string> = {};
for (const file of productPaths) {
  const expected = hash(
    execFileSync("git", ["show", `${appBase}:${file}`], {
      cwd: repo,
      maxBuffer: 128 * 1024 * 1024,
    }),
  );
  const disk = path.join(repo, file);
  const actual = hash(
    fs.lstatSync(disk).isSymbolicLink()
      ? fs.readlinkSync(disk)
      : fs.readFileSync(disk),
  );
  if (actual !== expected)
    throw new Error(`Product source differs from app-base ${file}`);
  productFiles[file] = actual;
}
const harnessFiles = Object.fromEntries(
  [
    "e2e/editingTaskReport.ts",
    "e2e/editingTaskState.ts",
    "e2e/editingTasks.ts",
    "e2e/editingTaskCases.ts",
    "e2e/editingTaskEvidence.ts",
    "e2e/editingTaskInputs.ts",
    "e2e/twoBrowserPages.ts",
    "e2e/editing-tasks.spec.ts",
    "scripts/profile-editing-tasks.ts",
    "e2e/editorProfile.ts",
    "e2e/editorProfileReport.ts",
    "e2e/liveProject.ts",
    "e2e/shareableProject.ts",
    "e2e/runE2e.ts",
    "e2e/port.ts",
    "e2e/processTree.ts",
    "e2e/runtimeEnv.ts",
    "e2e/env.ts",
    "e2e/guiCommand.ts",
    "e2e/cleanupManifest.ts",
    "e2e/pathInside.ts",
    "e2e/globalTeardown.ts",
    "playwright.config.ts",
    "scripts/start-e2e-gui.ts",
  ].map((file) => [file, hash(fs.readFileSync(file))]),
);
const source = {
  harnessFiles,
  productRevision: appBase,
  driverSha,
  dirty: git("status", "--porcelain"),
  productFiles,
};
fs.writeFileSync(
  path.join(output, "source.json"),
  JSON.stringify(source, null, 2),
);
type ProcessResult = Pick<
  SpawnSyncReturns<unknown>,
  "error" | "status" | "signal" | "stdout" | "stderr"
>;
function successfulProcess(
  result: ProcessResult,
  command: readonly string[],
  phase: "Backend import provenance" | "Production build",
): { stdout: string; stderr: string; status: 0 } {
  const context = `${phase} (${command.join(" ")})`;
  if (result.error)
    throw new Error(
      `${context} failed: ${result.error.message}${typeof result.stderr === "string" ? `\n${result.stderr}` : ""}`,
      { cause: result.error },
    );
  if (result.status !== 0 || result.signal !== null)
    throw new Error(
      `${context} failed with status ${result.status}, signal ${result.signal}${typeof result.stderr === "string" ? `\n${result.stderr}` : ""}`,
    );
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string")
    throw new Error(`${context} expected UTF8 stdout/stderr`);
  return { stdout: result.stdout, stderr: result.stderr, status: 0 };
}
const importCommand =
  "import json,os,sys,podcast_mcp.gui.server; print(json.dumps({'cwd':os.getcwd(),'executable':sys.executable,'module':podcast_mcp.gui.server.__file__}))";
const imported = spawnSync("uv", ["run", "python", "-c", importCommand], {
  cwd: repo,
  encoding: "utf8",
});
const backendOutput = successfulProcess(
  imported,
  ["uv", "run", "python", "-c", importCommand],
  "Backend import provenance",
);
fs.writeFileSync(
  path.join(output, "backend-import.log"),
  backendOutput.stdout + backendOutput.stderr,
);
const backend: unknown = JSON.parse(backendOutput.stdout.trim());
if (
  !isRecord(backend) ||
  typeof backend.cwd !== "string" ||
  backend.cwd.trim().length === 0 ||
  typeof backend.executable !== "string" ||
  backend.executable.trim().length === 0 ||
  typeof backend.module !== "string" ||
  backend.module.trim().length === 0
)
  throw new Error("Backend import provenance returned invalid metadata");
const canonicalRepo = fs.realpathSync(repo);
if (fs.realpathSync(backend.cwd) !== canonicalRepo)
  throw new Error("Backend import is outside verified app source");
const serverProductPath = "src/podcast_mcp/gui/server.py";
const serverPath = path.join(canonicalRepo, serverProductPath);
const canonicalModule = fs.realpathSync(backend.module);
if (canonicalModule !== serverPath)
  throw new Error("Backend import does not match admitted server source");
function requireRegularBackendSource(file: string): void {
  const root = [canonicalRepo, repo].find((candidate) =>
    file.startsWith(`${candidate}${path.sep}`),
  );
  if (!root)
    throw new Error("Backend import does not match admitted server source");
  let componentPath = canonicalRepo;
  for (const component of file.slice(root.length + 1).split(path.sep)) {
    componentPath = path.join(componentPath, component);
    const relative = path.relative(canonicalRepo, componentPath);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      fs.lstatSync(componentPath).isSymbolicLink()
    )
      throw new Error("Backend import does not match admitted server source");
  }
  if (!fs.lstatSync(componentPath).isFile())
    throw new Error("Backend import does not match admitted server source");
}
requireRegularBackendSource(serverPath);
requireRegularBackendSource(backend.module);
const backendSourceHash = hash(fs.readFileSync(canonicalModule));
if (backendSourceHash !== productFiles[serverProductPath])
  throw new Error("Backend import does not match admitted server source");
type BuildReceipt = {
  command: string[];
  exit: number;
  productRevision: string;
  buildEnvironment: {
    nodeEnv: string | null;
    viteSharecutE2e: string | null;
  };
  assets: Record<string, string>;
};
let dist: string;
let build: Omit<BuildReceipt, "assets">;
let buildAssets: Record<string, string> | undefined;
if (values["production-dist"]) {
  if (!values["build-receipt"] || !values["source-receipt"])
    throw new Error("Reused dist needs --build-receipt and --source-receipt");
  const parsedReceipt = JSON.parse(
    fs.readFileSync(values["build-receipt"], "utf8"),
  ) as Partial<BuildReceipt>;
  const sourceReceipt = JSON.parse(
    fs.readFileSync(values["source-receipt"], "utf8"),
  ) as { productRevision: string; productFiles: Record<string, string> };
  if (
    parsedReceipt.productRevision !== appBase ||
    parsedReceipt.exit !== 0 ||
    !Array.isArray(parsedReceipt.command) ||
    parsedReceipt.command.join("\0") !== "npm\0run\0build" ||
    parsedReceipt.buildEnvironment?.nodeEnv !== "production" ||
    parsedReceipt.buildEnvironment.viteSharecutE2e !== null ||
    !parsedReceipt.assets ||
    typeof parsedReceipt.assets !== "object" ||
    Array.isArray(parsedReceipt.assets) ||
    sourceReceipt.productRevision !== appBase
  )
    throw new Error(
      "Dist receipt does not prove a successful production build without E2E hooks",
    );
  for (const [file, expected] of Object.entries(sourceReceipt.productFiles))
    if (productFiles[file] !== expected)
      throw new Error(`Build source mismatch ${file}`);
  for (const file of productPaths)
    if (!sourceReceipt.productFiles[file])
      throw new Error(`Build source receipt omitted ${file}`);
  dist = path.resolve(values["production-dist"]);
  verifyEditingDistribution(dist, parsedReceipt.assets);
  const receipt = parsedReceipt as BuildReceipt;
  buildAssets = receipt.assets;
  build = {
    command: receipt.command,
    exit: receipt.exit,
    productRevision: receipt.productRevision,
    buildEnvironment: receipt.buildEnvironment,
  };
} else {
  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
  };
  delete buildEnv.VITE_SHARECUT_E2E;
  const command = ["npm", "run", "build"];
  const built = spawnSync(command[0], command.slice(1), {
    encoding: "utf8",
    env: buildEnv,
  });
  const buildOutput = successfulProcess(built, command, "Production build");
  fs.writeFileSync(
    path.join(output, "production-build.log"),
    buildOutput.stdout + buildOutput.stderr,
  );
  dist = path.join(output, "production-dist");
  fs.cpSync(path.resolve("dist"), dist, { recursive: true });
  build = {
    command,
    exit: buildOutput.status,
    productRevision: appBase,
    buildEnvironment: {
      nodeEnv: buildEnv.NODE_ENV ?? null,
      viteSharecutE2e: buildEnv.VITE_SHARECUT_E2E ?? null,
    },
  };
}
const assets: Record<string, string> = {};
function inspectAssets(directory: string) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) inspectAssets(file);
    else {
      const bytes = fs.readFileSync(file);
      if (
        /\.(js|css)$/.test(file) &&
        (bytes.includes("__SHARECUT_E2E") ||
          bytes.includes("__recordSignalCount"))
      )
        throw new Error("Production asset contains E2E hooks");
      assets[`/${path.relative(dist, file).split(path.sep).join("/")}`] =
        hash(bytes);
    }
  }
}
inspectAssets(dist);
const buildReceipt: BuildReceipt = {
  ...build,
  assets:
    buildAssets ??
    Object.fromEntries(
      Object.entries(assets).map(([file, sha256]) => [file.slice(1), sha256]),
    ),
};
fs.writeFileSync(
  path.join(output, "build.json"),
  JSON.stringify(buildReceipt, null, 2),
);
const mode = values.diagnostic
  ? "diagnostic"
  : values["validity-only"]
    ? "validity-only"
    : "baseline";
const schedule = tasks.flatMap((task) => {
  const routes = task.routes.filter(
    (route) =>
      !("pending" in route) &&
      (!selectedRoutes || selectedRoutes.includes(route.id)),
  );
  return Array.from({ length: Number(values.trials) }, (_, index) =>
    routes.map((route) => ({
      task: task.id,
      route: route.id,
      trial: index + 1,
    })),
  ).flat();
});
const protocol = {
  version: 7,
  retainedPriorFailures: [
    {
      task: "envelope",
      route: "point-form",
      historicalAppBase: "6033d77a2884697ae659f2b2b917cacae4b2e737",
      historicalStatus: "fail",
      historicalCause:
        "Pointer track-header center intercepted by track-meta before numeric input",
      evidence:
        "/workspace/poteto-workloads1035-evidence/all-routes-validity-2/envelope-point-form-1",
    },
    {
      task: "reorder",
      route: "move-up",
      historicalAppBase: "6033d77a2884697ae659f2b2b917cacae4b2e737",
      historicalStatus: "fail",
      historicalCause:
        "Pointer track-header center intercepted by track-meta before Move track up",
      evidence:
        "/workspace/poteto-workloads1035-evidence/all-routes-validity-2/reorder-move-up-1",
    },
  ],
  replayMedia,
  source,
  backend: {
    ...backend,
    cwd: canonicalRepo,
    module: canonicalModule,
    sourceHash: backendSourceHash,
  },
  build: buildReceipt,
  assets,
  tasks,
  schedule,
  mode,
  environment: {
    node: process.version,
    runnerNodeEnv: process.env.NODE_ENV ?? null,
    os: `${os.platform()} ${os.release()}`,
    cores: os.cpus().length,
    cpu: os.cpus()[0]?.model,
    cache:
      "fresh backend/context per attempt; generated waveform cache per fixture; OS caches uncontrolled",
    counting:
      "Each deliberate click/fill/check/focus/key or drag is one activation; held burst is one activation; task navigation included; setup/cancel/Undo separate",
    duration:
      "driver action plus UI geometry, saved-state polling and two animation frames",
    loadPolicy:
      "serial attempts; load average retained; timing inconclusive without limiter/noise evidence",
  },
};
const protocolJson = JSON.stringify(protocol, null, 2);
fs.writeFileSync(path.join(output, "protocol.json"), protocolJson);
fs.writeFileSync(path.join(output, "protocol.sha256"), hash(protocolJson));
type Scheduled = (typeof schedule)[number];
type RunnerOutcome =
  | { kind: "returned"; code: number }
  | { kind: "rejected"; error: string };
type SemanticReceipt =
  | {
      kind: "assessed";
      result: ReturnType<typeof assessEditingTrial>;
      observedDurationMs: number | null;
    }
  | { kind: "unavailable"; error: string };
type ProfileAdmission =
  | { kind: "admitted" }
  | { kind: "excluded"; reason: string };
type Admission =
  | { kind: "admitted"; durationMs: number }
  | { kind: "rejected"; reasons: string[] };
type FinalAttempt = Scheduled &
  (
    | { kind: "not-run"; reason: string }
    | {
        kind: "invoked";
        runner: RunnerOutcome;
        semantic: SemanticReceipt;
        profile: ProfileAdmission;
        admission: Admission;
        loadBefore: number[];
        loadAfter: number[];
      }
  );
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseProfileAdmission(raw: unknown): ProfileAdmission {
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    (raw.measurementVersion !== "editor-response-v1" &&
      raw.measurementVersion !== "editor-workloads-v2")
  )
    return {
      kind: "excluded",
      reason: "Unrecognized profiler schema or measurement version",
    };
  if (raw.status !== "complete")
    return { kind: "excluded", reason: "Profiler report is not complete" };
  if (
    !Array.isArray(raw.errors) ||
    !raw.errors.every((error) => typeof error === "string") ||
    raw.errors.length !== 0
  )
    return {
      kind: "excluded",
      reason: "Profiler errors must be an empty string array",
    };
  const build = isRecord(raw.environment) ? raw.environment.build : undefined;
  if (
    !isRecord(build) ||
    build.status !== "measured" ||
    !isRecord(build.value) ||
    !Array.isArray(build.value.assets) ||
    build.value.assets.length === 0
  )
    return {
      kind: "excluded",
      reason: "Served production assets not observed",
    };
  const paths = new Set<string>();
  for (const asset of build.value.assets) {
    if (
      !isRecord(asset) ||
      typeof asset.path !== "string" ||
      !asset.path.startsWith("/") ||
      typeof asset.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      paths.has(asset.path)
    )
      return { kind: "excluded", reason: "Malformed served asset inventory" };
    paths.add(asset.path);
    if (
      !Object.hasOwn(assets, asset.path) ||
      assets[asset.path] !== asset.sha256
    )
      return {
        kind: "excluded",
        reason: `Served asset differs from admitted build ${asset.path}`,
      };
  }
  return { kind: "admitted" };
}
function assessRetainedTrial(
  scheduled: Scheduled,
  attempt: string,
): SemanticReceipt {
  try {
    const trial = JSON.parse(
      fs.readFileSync(path.join(attempt, "trial.json"), "utf8"),
    ) as EditingTrial;
    if (trial.task !== scheduled.task || trial.route !== scheduled.route)
      throw new Error("Retained trial identity differs from scheduled slot");
    return {
      kind: "assessed",
      result: assessEditingTrial(
        tasks.find((task) => task.id === scheduled.task)!,
        trial,
      ),
      observedDurationMs:
        typeof trial.durationMs === "number" ? trial.durationMs : null,
    };
  } catch (error) {
    return { kind: "unavailable", error: String(error) };
  }
}
function admitRetainedProfile(attempt: string): ProfileAdmission {
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(attempt, "profiler", "report.json"), "utf8"),
    );
    return parseProfileAdmission(raw);
  } catch (error) {
    return { kind: "excluded", reason: String(error) };
  }
}
function qualify(
  runner: RunnerOutcome,
  semantic: SemanticReceipt,
  profile: ProfileAdmission,
): Admission {
  const reasons: string[] = [];
  if (runner.kind === "rejected")
    reasons.push(`Runner rejected: ${runner.error}`);
  else if (runner.code !== 0)
    reasons.push(`Runner returned exit code ${runner.code}`);
  if (semantic.kind === "unavailable")
    reasons.push(`Semantic receipt unavailable: ${semantic.error}`);
  else if (semantic.result.status !== "pass")
    reasons.push(...semantic.result.reasons);
  if (profile.kind === "excluded")
    reasons.push(`Profile excluded: ${profile.reason}`);
  const durationMs =
    semantic.kind === "assessed" ? semantic.observedDurationMs : null;
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0)
    reasons.push("Elapsed duration is missing, non-finite or negative");
  return reasons.length === 0 && durationMs !== null
    ? { kind: "admitted", durationMs }
    : { kind: "rejected", reasons };
}
function summaryRow(attempt: FinalAttempt): EditingSummaryAttempt {
  const { task, route, trial } = attempt;
  if (attempt.kind === "not-run")
    return { task, route, trial, kind: "not-run", reason: attempt.reason };
  return attempt.admission.kind === "admitted"
    ? {
        task,
        route,
        trial,
        kind: "admitted",
        mode,
        durationMs: attempt.admission.durationMs,
      }
    : { task, route, trial, kind: "rejected", mode };
}
const attempts: FinalAttempt[] = schedule.map((scheduled) => ({
  ...scheduled,
  kind: "not-run",
  reason: "Scheduled attempt has not been invoked",
}));
const reportingErrors: string[] = [];
let stopReason: string | null = null;
let lifetimeError: string | null = null;
const attemptDirectory = (scheduled: Scheduled) =>
  path.join(output, `${scheduled.task}-${scheduled.route}-${scheduled.trial}`);
function retainReport(file: string, value: unknown): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
    return true;
  } catch (error) {
    const reason = `Report retention failed ${file}: ${String(error)}`;
    reportingErrors.push(reason);
    stopReason ??= reason;
    return false;
  }
}
function retainStatus(attempt: FinalAttempt): void {
  retainReport(path.join(attemptDirectory(attempt), "status.json"), {
    ...attempt,
    status:
      attempt.kind === "not-run"
        ? "not-run"
        : attempt.admission.kind === "admitted"
          ? "pass"
          : "fail",
  });
}
try {
  for (const attempt of attempts) retainStatus(attempt);
  retainReport(path.join(output, "attempts.json"), attempts);
  for (const [index, scheduled] of schedule.entries()) {
    if (stopReason) break;
    const attempt = attemptDirectory(scheduled);
    if (
      !retainReport(path.join(attempt, "status.json"), {
        ...scheduled,
        status: "running",
      })
    )
      break;
    Object.assign(process.env, {
      EDITING_REPLAY_MEDIA: replayReceipt,
      EDITING_TASK: scheduled.task,
      PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(attempt, "playwright-report.json"),
      EDITING_ROUTE: scheduled.route,
      EDITING_TASK_OUT: attempt,
      EDITING_MODE: mode,
      EDITING_PROTOCOL_HASH: hash(protocolJson),
      DAW_PROFILE_OUT: path.join(attempt, "profiler"),
      PODCAST_GUI_DIST: dist,
      PODCAST_SHARE_REGISTRY: path.join(attempt, "share-registry.sqlite"),
      DAW_PROFILE_TRACE: values.diagnostic ? "1" : "",
    });
    delete process.env.DAW_E2E_PROJECT;
    const loadBefore = os.loadavg();
    let runner: RunnerOutcome;
    try {
      const code = await runE2e(
        [
          "editing-tasks.spec.ts",
          "--retries=0",
          "--trace=off",
          "--reporter=list,json",
          `--output=${path.join(attempt, "playwright")}`,
        ],
        undefined,
        undefined,
        () => acquireE2ePortLease({ ...process.env, DAW_E2E_PORT: undefined }),
      );
      runner = { kind: "returned", code };
    } catch (error) {
      runner = { kind: "rejected", error: String(error) };
    }
    const semantic = assessRetainedTrial(scheduled, attempt);
    const profile = admitRetainedProfile(attempt);
    const row: FinalAttempt = {
      ...scheduled,
      kind: "invoked",
      runner,
      semantic,
      profile,
      admission: qualify(runner, semantic, profile),
      loadBefore,
      loadAfter: os.loadavg(),
    };
    attempts[index] = row;
    if (runner.kind === "rejected")
      stopReason = `Stopped after runner rejection for ${scheduled.task}/${scheduled.route}/${scheduled.trial}: ${runner.error}`;
    retainStatus(row);
    retainReport(path.join(output, "attempts.json"), attempts);
  }
} catch (error) {
  lifetimeError = String(error);
  stopReason ??= `Stopped after CLI lifetime failure: ${lifetimeError}`;
} finally {
  for (const [index, attempt] of attempts.entries()) {
    if (attempt.kind === "not-run" && stopReason)
      attempts[index] = { ...attempt, reason: stopReason };
  }
  for (const attempt of attempts) retainStatus(attempt);
  retainReport(path.join(output, "attempts.json"), attempts);
  const routes = summarizeEditingAttempts(
    editingTaskRegistry,
    attempts.map(summaryRow),
  );
  const selectedProofComplete =
    reportingErrors.length === 0 &&
    lifetimeError === null &&
    schedule.length > 0 &&
    attempts.length === schedule.length &&
    attempts.every((attempt, index) => {
      const scheduled = schedule[index];
      return (
        attempt.task === scheduled.task &&
        attempt.route === scheduled.route &&
        attempt.trial === scheduled.trial &&
        attempt.kind === "invoked" &&
        attempt.admission.kind === "admitted"
      );
    });
  const summary = {
    retainedPriorFailures: protocol.retainedPriorFailures,
    selected: {
      tasks: tasks.map((task) => task.id),
      routes: [...new Set(schedule.map((row) => `${row.task}/${row.route}`))],
    },
    fullSupportedCoverage: {
      complete:
        reportingErrors.length === 0 &&
        lifetimeError === null &&
        routes
          .filter((row) => row.status !== "pending")
          .every(
            (row) =>
              row.status === "pass" && row.valid === Number(values.trials),
          ),
      total: routes.filter((row) => row.status !== "pending").length,
      attempted: routes.filter(
        (row) => row.status !== "pending" && row.attempted > 0,
      ).length,
      passed: routes.filter((row) => row.status === "pass").length,
    },
    selectedProofComplete,
    reporting: {
      status: reportingErrors.length ? "failed" : "complete",
      errors: reportingErrors,
    },
    lifetimeError,
    timing: {
      status: "inconclusive",
      reason:
        mode !== "baseline"
          ? "Validity and diagnostic trials excluded from statistics"
          : "Limiter and concurrent noise not independently established",
    },
    attempts,
    routes,
    pending: tasks.flatMap((task) =>
      task.routes
        .filter((route) => "pending" in route)
        .map((route) => ({ task: task.id, ...route })),
    ),
  };
  const retainedSummary = retainReport(
    path.join(output, "summary.json"),
    summary,
  );
  process.exitCode =
    retainedSummary && selectedProofComplete && reportingErrors.length === 0
      ? 0
      : 1;
}
