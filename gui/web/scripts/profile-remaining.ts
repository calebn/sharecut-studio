import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { acquireE2ePortLease } from "../e2e/port";
import { runE2e } from "../e2e/runE2e";

const { values } = parseArgs({
  options: {
    preset: { type: "string", default: "small" },
    repeat: { type: "string", default: "1" },
    out: { type: "string" },
    scene: { type: "string" },
    trace: { type: "boolean", default: false },
  },
});
const scenes = [
  "clip",
  "boundary",
  "playback",
  "cold-waveform",
  "progress-replay",
  "progress-real",
  "progress-reduced",
];
if (
  !values.out ||
  !["small", "large"].includes(values.preset!) ||
  !/^\d+$/.test(values.repeat!) ||
  Number(values.repeat) < 1 ||
  (values.scene && !scenes.includes(values.scene))
)
  throw new Error(
    "Usage: profile:remaining -- --preset small|large --repeat N --out NEW_DIRECTORY [--scene NAME] [--trace]",
  );
const output = path.resolve(values.out);
if (fs.existsSync(output))
  throw new Error(`Refusing to overwrite retained evidence: ${output}`);
fs.mkdirSync(output, { recursive: true });
const repo = path.resolve("../..");
let failed = false;
for (let repeat = 1; repeat <= Number(values.repeat); repeat++) {
  for (const scene of values.scene ? [values.scene] : scenes) {
    const root = path.join(output, `run-${repeat}`, scene);
    const fixture = path.join(root, "fixture");
    fs.mkdirSync(root, { recursive: true });
    const args = [
      "run",
      "python",
      "scripts/build_large_project_fixture.py",
      "--out",
      fixture,
      "--tone-seconds",
      "20",
    ];
    if (values.preset === "small")
      args.push(
        "--duration",
        "120",
        "--clips",
        "24",
        "--utterances",
        "200",
        "--history",
        "20",
      );
    const built = spawnSync("uv", args, { cwd: repo, encoding: "utf8" });
    fs.writeFileSync(
      path.join(root, "fixture-build.log"),
      built.stdout + built.stderr,
    );
    if (built.status !== 0) {
      failed = true;
      continue;
    }
    if (scene === "cold-waveform")
      fs.rmSync(path.join(fixture, "artifacts", "peaks"), {
        recursive: true,
        force: true,
      });
    Object.assign(process.env, {
      DAW_E2E_PROJECT: path.join(fixture, "episode.project.json"),
      DAW_PROFILE_OUT: root,
      DAW_PROFILE_SCENE: scene,
      DAW_PROFILE_TRACE: values.trace ? "1" : "",
      DAW_PROFILE_REPEAT: String(repeat),
    });
    const leaseEnv = { ...process.env, DAW_E2E_PORT: undefined };
    const code = await runE2e(
      [
        "editor-workloads.spec.ts",
        "--retries=0",
        "--trace=off",
        `--output=${path.join(root, "playwright")}`,
      ],
      undefined,
      undefined,
      () => acquireE2ePortLease(leaseEnv),
    );
    failed ||= code !== 0;
    if (code === 0) fs.rmSync(fixture, { recursive: true, force: true });
  }
}
fs.writeFileSync(
  path.join(output, "invocation.json"),
  `${JSON.stringify({ values, scenes: values.scene ? [values.scene] : scenes, status: failed ? "incomplete" : "complete" }, null, 2)}\n`,
);
process.exitCode = failed ? 1 : 0;
