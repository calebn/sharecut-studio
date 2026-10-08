import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  assessEditingTrial,
  type EditingTrial,
  summarizeEditingAttempts,
} from "../e2e/editingTaskReport";
import {
  editingTaskRegistry,
  verifyEditingDistribution,
} from "../e2e/editingTasks";
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
const isProductPath = (file: string) =>
  file.startsWith("src/podcast_mcp/") ||
  file.startsWith("gui/web/src/") ||
  file.startsWith("gui/web/public/") ||
  [
    "gui/web/package.json",
    "gui/web/package-lock.json",
    "gui/web/vite.config.ts",
    "pyproject.toml",
    "uv.lock",
  ].includes(file);
const productPaths = git("ls-tree", "-r", "--name-only", appBase)
  .split("\n")
  .filter(isProductPath);
const additions = [
  ...git("ls-files").split("\n"),
  ...git("ls-files", "--others", "--exclude-standard").split("\n"),
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
    "e2e/editingTasks.ts",
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
  appBase,
  driverSha,
  dirty: git("status", "--porcelain"),
  productFiles,
};
fs.writeFileSync(
  path.join(output, "source.json"),
  JSON.stringify(source, null, 2),
);
const imported = spawnSync(
  "uv",
  [
    "run",
    "python",
    "-c",
    "import json,os,sys,podcast_mcp.gui.server; print(json.dumps({'cwd':os.getcwd(),'executable':sys.executable,'module':podcast_mcp.gui.server.__file__}))",
  ],
  { cwd: repo, encoding: "utf8" },
);
fs.writeFileSync(
  path.join(output, "backend-import.log"),
  imported.stdout + imported.stderr,
);
if (imported.status !== 0) throw new Error("Backend import provenance failed");
const backend = JSON.parse(imported.stdout.trim()) as {
  cwd: string;
  executable: string;
  module: string;
};
if (backend.cwd !== repo || !backend.module.startsWith(`${repo}/src/`))
  throw new Error("Backend import is outside verified app source");
const backendSourceHash = hash(fs.readFileSync(backend.module));
let dist: string;
let build: unknown;
if (values["production-dist"]) {
  if (!values["build-receipt"] || !values["source-receipt"])
    throw new Error("Reused dist needs --build-receipt and --source-receipt");
  const receipt = JSON.parse(
    fs.readFileSync(values["build-receipt"], "utf8"),
  ) as {
    productRevision: string;
    exit: number;
    assets: Record<string, string>;
  };
  const sourceReceipt = JSON.parse(
    fs.readFileSync(values["source-receipt"], "utf8"),
  ) as { productRevision: string; productFiles: Record<string, string> };
  if (
    receipt.productRevision !== appBase ||
    receipt.exit !== 0 ||
    sourceReceipt.productRevision !== appBase
  )
    throw new Error(
      "Dist receipt does not prove successful app-base production build",
    );
  for (const [file, expected] of Object.entries(sourceReceipt.productFiles))
    if (productFiles[file] !== expected)
      throw new Error(`Build source mismatch ${file}`);
  for (const file of productPaths)
    if (!sourceReceipt.productFiles[file])
      throw new Error(`Build source receipt omitted ${file}`);
  dist = path.resolve(values["production-dist"]);
  verifyEditingDistribution(dist, receipt.assets);
  build = receipt;
} else {
  const env = { ...process.env };
  delete env.VITE_SHARECUT_E2E;
  const built = spawnSync("npm", ["run", "build"], { encoding: "utf8", env });
  fs.writeFileSync(
    path.join(output, "production-build.log"),
    built.stdout + built.stderr,
  );
  if (built.status !== 0) throw new Error("Production build failed");
  dist = path.join(output, "production-dist");
  fs.cpSync(path.resolve("dist"), dist, { recursive: true });
  build = {
    command: ["npm", "run", "build"],
    exit: built.status,
    productRevision: appBase,
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
    (index % 2 ? [...routes].reverse() : routes).map((route) => ({
      task: task.id,
      route: route.id,
      trial: index + 1,
    })),
  ).flat();
});
const protocol = {
  version: 4,
  retainedPriorFailures: [
    {
      task: "envelope",
      route: "point-form",
      status: "fail",
      cause:
        "Pointer track-header center intercepted by track-meta before numeric input",
      evidence:
        "/workspace/poteto-workloads1035-evidence/all-routes-validity-2/envelope-point-form-1",
    },
    {
      task: "reorder",
      route: "move-up",
      status: "fail",
      cause:
        "Pointer track-header center intercepted by track-meta before Move track up",
      evidence:
        "/workspace/poteto-workloads1035-evidence/all-routes-validity-2/reorder-move-up-1",
    },
  ],
  replayMedia,
  source,
  backend: { ...backend, sourceHash: backendSourceHash },
  build,
  assets,
  tasks,
  schedule,
  mode,
  environment: {
    node: process.version,
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
const attempts: {
  task: string;
  route: string;
  trial: number;
  code: number;
  result: ReturnType<typeof assessEditingTrial> | null;
  error: string | null;
  loadBefore: number[];
  loadAfter: number[];
  durationMs?: number;
}[] = [];
for (const scheduled of schedule) {
  const attempt = path.join(
    output,
    `${scheduled.task}-${scheduled.route}-${scheduled.trial}`,
  );
  fs.mkdirSync(attempt);
  fs.writeFileSync(
    path.join(attempt, "status.json"),
    JSON.stringify({ status: "not-run", ...scheduled }),
  );
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
  let result: ReturnType<typeof assessEditingTrial> | null = null;
  let error: string | null = null;
  let durationMs: number | undefined;
  try {
    const trial = JSON.parse(
      fs.readFileSync(path.join(attempt, "trial.json"), "utf8"),
    ) as EditingTrial;
    durationMs = trial.durationMs;
    result = assessEditingTrial(
      tasks.find((task) => task.id === scheduled.task)!,
      trial,
    );
    const profile = JSON.parse(
      fs.readFileSync(path.join(attempt, "profiler", "report.json"), "utf8"),
    ) as {
      environment: {
        build: {
          status: string;
          value?: { assets: { path: string; sha256: string }[] };
        };
      };
    };
    const observed = profile.environment.build;
    if (observed.status !== "measured" || !observed.value?.assets.length)
      throw new Error("Served production assets not observed");
    for (const asset of observed.value.assets)
      if (assets[asset.path] !== asset.sha256)
        throw new Error(
          `Served asset differs from admitted build ${asset.path}`,
        );
  } catch (failure) {
    error = String(failure);
  }
  attempts.push({
    ...scheduled,
    code,
    result,
    error,
    loadBefore,
    loadAfter: os.loadavg(),
    durationMs,
  });
  fs.writeFileSync(
    path.join(output, "attempts.json"),
    JSON.stringify(attempts, null, 2),
  );
}
const routes = summarizeEditingAttempts(
  editingTaskRegistry,
  attempts.map((attempt) => ({
    task: attempt.task,
    route: attempt.route,
    valid:
      attempt.code === 0 && attempt.result?.status === "pass" && !attempt.error,
    mode,
    durationMs: attempt.durationMs,
  })),
);
const summary = {
  retainedPriorFailures: protocol.retainedPriorFailures,
  selected: {
    tasks: tasks.map((task) => task.id),
    routes: [...new Set(schedule.map((row) => `${row.task}/${row.route}`))],
  },
  fullSupportedCoverage: {
    complete: routes
      .filter((row) => row.status !== "pending")
      .every(
        (row) => row.status === "pass" && row.valid === Number(values.trials),
      ),
    total: routes.filter((row) => row.status !== "pending").length,
    attempted: routes.filter(
      (row) => row.status !== "pending" && row.attempted > 0,
    ).length,
    passed: routes.filter((row) => row.status === "pass").length,
  },
  selectedProofComplete:
    attempts.length > 0 &&
    attempts.every(
      (attempt) =>
        attempt.code === 0 &&
        attempt.result?.status === "pass" &&
        !attempt.error,
    ),
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
fs.writeFileSync(
  path.join(output, "summary.json"),
  JSON.stringify(summary, null, 2),
);
process.exitCode = summary.selectedProofComplete ? 0 : 1;
