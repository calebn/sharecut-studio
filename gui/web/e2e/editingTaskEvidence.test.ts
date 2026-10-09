import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  cleanupE2eManifest,
  createE2eCleanupManifest,
} from "./cleanupManifest";
import { editingTaskRegistry } from "./editingTaskCases";
import {
  createEditingFixture,
  readEditingState,
  retainEditingMedia,
  verifyEditingDistribution,
} from "./editingTaskEvidence";
import { savedStateDifferences } from "./editingTaskState";

const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function smallProject(dir: string) {
  const baseline = editingTaskRegistry[0].start;
  const project = {
    sources: [
      {
        id: "reference_src0",
        path: "raw/reference.wav",
        speaker: "reference",
        label: "reference.wav",
        offset_sec: 0,
        duration_sec: null,
        sample_rate: null,
        channels: null,
        clipping_regions: [],
        clipping_truncated: false,
      },
      {
        id: "guest_src0",
        path: "raw/guest.wav",
        speaker: "guest",
        label: "guest.wav",
        offset_sec: 0,
        duration_sec: null,
        sample_rate: null,
        channels: null,
        clipping_regions: [],
        clipping_truncated: false,
      },
    ],
    timeline: {
      duration_sec: 20,
      clips: structuredClone(baseline.clips),
      tracks: baseline.tracks.map(({ invariants, ...row }) => ({
        ...row,
        ...(invariants as object),
      })),
    },
    editorial: {
      chapters: [],
      speaker_splits: [],
      retained_bleed_alignments: [],
    },
    mix: { automation_envelopes: [], processing_chains: [] },
    social: { clip_candidates: [] },
    review: { comments: [], versions: [], active_version_id: null },
  };
  const file = path.join(dir, "episode.project.json");
  fs.writeFileSync(file, JSON.stringify(project));
  return { project, file };
}
it("binds saved source identity and recording path through the real reader", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editing-source-test-"));
  try {
    const { project, file } = smallProject(dir);
    project.timeline.clips[0].source_id = "reference_src0";
    fs.writeFileSync(file, JSON.stringify(project));
    const before = readEditingState(file);
    expect(savedStateDifferences(before, readEditingState(file))).toEqual([]);

    project.sources[0].path = "guest.wav";
    fs.writeFileSync(file, JSON.stringify(project));
    expect(
      savedStateDifferences(before, readEditingState(file)).some((path) =>
        path.includes("sources.0.path"),
      ),
    ).toBe(true);

    project.sources[0].path = "reference.wav";
    project.timeline.clips[0].source_id = "guest_src0";
    fs.writeFileSync(file, JSON.stringify(project));
    expect(
      savedStateDifferences(before, readEditingState(file)).some((path) =>
        path.includes("source_id"),
      ),
    ).toBe(true);

    project.timeline.clips[0].source_id = "reference_src0";
    project.sources = project.sources.slice(1);
    fs.writeFileSync(file, JSON.stringify(project));
    expect(() => readEditingState(file)).toThrow(
      "Durable clip references a missing source",
    );

    project.sources = [
      {
        id: "reference_src0",
        path: "reference.wav",
        speaker: "reference",
        label: "reference.wav",
        offset_sec: 0,
        duration_sec: null,
        sample_rate: null,
        channels: null,
        clipping_regions: [],
        clipping_truncated: false,
      },
      ...project.sources,
    ];
    project.sources[1].id = "reference_src0";
    fs.writeFileSync(file, JSON.stringify(project));
    expect(() => readEditingState(file)).toThrow(
      "Invalid or duplicate durable source identity",
    );

    project.sources = [];
    project.timeline.clips[0].source_id = null;
    fs.writeFileSync(file, JSON.stringify(project));
    expect(readEditingState(file).sources).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it("rejects identical raw split IDs before aliases and preserves unaffected identity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editing-identity-test-"));
  try {
    const { project, file } = smallProject(dir);
    project.timeline.clips = structuredClone(
      editingTaskRegistry[1].expected.clips,
    );
    project.timeline.clips[1].id = "same-duplicate-id";
    project.timeline.clips[2].id = "same-duplicate-id";
    fs.writeFileSync(file, JSON.stringify(project));
    expect(() => readEditingState(file, true)).toThrow(
      "Raw saved clip IDs are not unique",
    );
    project.timeline.clips[2].id = "generated-right";
    fs.writeFileSync(file, JSON.stringify(project));
    const mapping: Record<string, string> = {};
    expect(readEditingState(file, true, mapping)).toEqual(
      editingTaskRegistry[1].expected,
    );
    expect(mapping).toEqual({
      "first-copy": "first-copy",
      "same-duplicate-id": "cut-left",
      "generated-right": "cut-right",
      peer: "peer",
    });
    project.timeline.clips[1].id = "second-copy";
    fs.writeFileSync(file, JSON.stringify(project));
    expect(
      savedStateDifferences(
        editingTaskRegistry[1].expected,
        readEditingState(file, true),
      ).length,
    ).toBeGreaterThan(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it.each([
  "duration",
  "role",
  "media",
  "chapters",
  "extra-clip",
  "wrong-occurrence",
  "no-op",
])("rejects saved %s through actual reader", (fault) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editing-state-test-"));
  try {
    const { project, file } = smallProject(dir);
    const task = editingTaskRegistry[2];
    project.timeline.clips = structuredClone(task.expected.clips);
    project.timeline.duration_sec = 19.7;
    if (fault === "duration") project.timeline.duration_sec = 999;
    if (fault === "role") project.timeline.tracks[0].role = "music";
    if (fault === "media")
      project.timeline.tracks[0].media = {
        path: "raw/guest.wav",
        duration_sec: 60,
        sample_rate: 48000,
        channels: 1,
      };
    if (fault === "chapters")
      Object.assign(project.editorial, { chapters: [{ id: "unexpected" }] });
    if (fault === "extra-clip")
      project.timeline.clips.push({
        ...project.timeline.clips[0],
        id: "extra",
      });
    if (fault === "wrong-occurrence") {
      project.timeline.clips[0].source_start = 0;
      project.timeline.clips[1].source_start = 0.3;
    }
    if (fault === "no-op") {
      project.timeline.clips = structuredClone(task.start.clips);
      project.timeline.duration_sec = 20;
    }
    fs.writeFileSync(file, JSON.stringify(project));
    expect(
      savedStateDifferences(task.expected, readEditingState(file)).length,
    ).toBeGreaterThan(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it("requires complete index and public asset inventory and exact hashes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editing-dist-test-"));
  try {
    fs.writeFileSync(path.join(dir, "index.html"), "app");
    fs.writeFileSync(path.join(dir, "favicon.svg"), "icon");
    const assets = {
      "index.html": digest("app"),
      "favicon.svg": digest("icon"),
    };
    expect(verifyEditingDistribution(dir, assets)).toEqual(assets);
    expect(() => verifyEditingDistribution(dir, {})).toThrow("inventory");
    expect(() =>
      verifyEditingDistribution(dir, { "index.html": digest("app") }),
    ).toThrow("inventory");
    expect(() =>
      verifyEditingDistribution(dir, { ...assets, "extra.js": digest("x") }),
    ).toThrow("inventory");
    expect(() =>
      verifyEditingDistribution(dir, {
        ...assets,
        "index.html": digest("wrong"),
      }),
    ).toThrow("mismatch");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it("retains every distinct mismatching and unexpected media input before aggregate failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editing-media-test-"));
  try {
    const { file } = smallProject(dir);
    fs.mkdirSync(path.join(dir, "raw"));
    const evidence = path.join(dir, "evidence");
    fs.mkdirSync(evidence);
    const replay: Record<
      string,
      { relativePath: string; retainedPath: string; sha256: string }
    > = {};
    for (const id of ["reference", "guest"]) {
      const retainedPath = path.join(dir, `expected-${id}`);
      fs.writeFileSync(retainedPath, "expected");
      fs.writeFileSync(path.join(dir, "raw", `${id}.wav`), `unique-${id}`);
      replay[id] = {
        relativePath: `raw/${id}.wav`,
        retainedPath,
        sha256: digest("expected"),
      };
    }
    fs.writeFileSync(
      path.join(dir, "raw", "unexpected.wav"),
      "unique-unexpected",
    );
    expect(() => retainEditingMedia(dir, file, evidence, replay)).toThrow(
      /reference.*guest.*unexpected/,
    );
    const map = JSON.parse(
      fs.readFileSync(
        path.join(evidence, `media-map-${path.basename(dir)}.json`),
        "utf8",
      ),
    );
    for (const [id, bytes] of [
      ["reference", "unique-reference"],
      ["guest", "unique-guest"],
      ["raw/unexpected.wav", "unique-unexpected"],
    ]) {
      expect(fs.readFileSync(map.media[id].retainedPath, "utf8")).toBe(bytes);
      expect(map.media[id].sha256).toBe(digest(bytes));
    }
    fs.unlinkSync(path.join(dir, "raw", "unexpected.wav"));
    for (const id of ["reference", "guest"])
      fs.writeFileSync(path.join(dir, "raw", `${id}.wav`), "expected");
    expect(
      Object.keys(retainEditingMedia(dir, file, evidence, replay)),
    ).toEqual(["reference", "guest"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it("reads nullable current source descriptors and rejects fractional recording counts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editing-null-source-"));
  try {
    const { project, file } = smallProject(dir);
    Object.assign(project.sources[0], { speaker: null, label: null });
    fs.writeFileSync(file, JSON.stringify(project));
    expect(readEditingState(file).sources[0]).toEqual({
      id: "reference_src0",
      path: "raw/reference.wav",
      speaker: null,
      label: null,
      offset_sec: 0,
      duration_sec: null,
      sample_rate: null,
      channels: null,
      clipping_regions: [],
      clipping_truncated: false,
    });
    for (const key of ["sample_rate", "channels"]) {
      Object.assign(project.sources[0], { [key]: 1.5 });
      fs.writeFileSync(file, JSON.stringify(project));
      expect(() => readEditingState(file)).toThrow(
        "Invalid or duplicate durable source identity",
      );
      Object.assign(project.sources[0], { [key]: null });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it.each([
  "gui/web/index.html",
  ".agents/defaults/pipeline.yaml",
  "contracts/timeline-zoom.json",
])(
  "rejects changed production input %s through the actual CLI before launch",
  (inputPath) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editing-cli-source-"));
    try {
      const web = path.join(dir, "gui/web");
      fs.mkdirSync(web, { recursive: true });
      const raw = path.join(dir, "tests/fixtures/aligned_dialogue/raw");
      fs.mkdirSync(raw, { recursive: true });
      for (const id of ["reference", "guest"])
        fs.writeFileSync(path.join(raw, `${id}.wav`), id);
      const index = path.join(dir, inputPath);
      fs.mkdirSync(path.dirname(index), { recursive: true });
      fs.writeFileSync(index, "original HTML");
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
      git("init", "-q");
      git("add", ".");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "fixture",
      );
      const base = git("rev-parse", "HEAD");
      fs.writeFileSync(index, "changed HTML");
      const result = spawnSync(
        process.execPath,
        [
          path.resolve("node_modules/vite-node/dist/cli.mjs"),
          path.resolve("scripts/profile-editing-tasks.ts"),
          "--app-base",
          base,
          "--validity-only",
          "--trials",
          "1",
          "--out",
          path.join(dir, "evidence"),
        ],
        { cwd: web, encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        `Product source differs from app-base ${inputPath}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

it("preserves meaningful nested saved comment content and actor associations", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editing-comment-test-"));
  try {
    const { project, file } = smallProject(dir);
    const comment = {
      id: "task-comment",
      body: "Editing task comment",
      author: "Host",
      timeline_start: 2,
      timeline_end: 4,
      track_ids: [],
      resolved: true,
      resolved_by: "Host",
      review_version_id: "version",
      edit_decision_id: "decision",
      timeline_spans: [{ start: 2, end: 4 }],
      action_items: [
        {
          id: "action",
          text: "Review this",
          done: true,
          completed_by: "Editor",
          completed_at: "volatile",
        },
      ],
      replies: [
        {
          id: "reply",
          body: "Keep this",
          author: "Editor",
          created_at: "volatile",
        },
      ],
    };
    Object.assign(project.review, { comments: [comment] });
    fs.writeFileSync(file, JSON.stringify(project));
    expect(readEditingState(file).comments).toEqual([
      {
        ...comment,
        action_items: [
          {
            id: "action",
            text: "Review this",
            done: true,
            completed_by: "Editor",
          },
        ],
        replies: [{ id: "reply", body: "Keep this", author: "Editor" }],
      },
    ]);
    const before = readEditingState(file);
    for (const [key, value] of Object.entries({
      replies: [],
      action_items: [],
      timeline_spans: [],
      review_version_id: null,
      edit_decision_id: null,
      resolved_by: "Wrong actor",
    })) {
      Object.assign(project.review, {
        comments: [{ ...comment, [key]: value }],
      });
      fs.writeFileSync(file, JSON.stringify(project));
      expect(
        savedStateDifferences(before, readEditingState(file)).some((row) =>
          row.includes(key),
        ),
      ).toBe(true);
    }
    for (const malformed of [
      { replies: null },
      { replies: [{ id: "x", body: 9, author: "Host" }] },
      {
        action_items: [
          { id: "x", text: "x", done: "false", completed_by: null },
        ],
      },
      { timeline_spans: [{ start: 4, end: 2 }] },
      { resolved_by: 5 },
    ]) {
      Object.assign(project.review, {
        comments: [{ ...comment, ...malformed }],
      });
      fs.writeFileSync(file, JSON.stringify(project));
      expect(() => readEditingState(file)).toThrow();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it("retains declared selected and unused recordings outside raw before aggregate failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editing-source-media-"));
  try {
    const { project, file } = smallProject(dir);
    fs.mkdirSync(path.join(dir, "raw"));
    const evidence = path.join(dir, "evidence");
    fs.mkdirSync(evidence);
    const replay: Record<
      string,
      { relativePath: string; retainedPath: string; sha256: string }
    > = {};
    for (const id of ["reference", "guest"]) {
      fs.writeFileSync(path.join(dir, "raw", `${id}.wav`), id);
      const retainedPath = path.join(evidence, `${id}.wav`);
      fs.writeFileSync(retainedPath, id);
      replay[id] = {
        relativePath: `raw/${id}.wav`,
        retainedPath,
        sha256: digest(id),
      };
    }
    fs.writeFileSync(file, JSON.stringify(project));
    expect(
      Object.keys(retainEditingMedia(dir, file, evidence, replay)),
    ).toEqual(["reference", "guest"]);
    for (const name of ["selected-extra.wav", "unused-extra.wav"]) {
      fs.writeFileSync(path.join(dir, name), name);
      project.sources.push({ ...project.sources[0], id: name, path: name });
    }
    project.timeline.clips[0].source_id = "selected-extra.wav";
    fs.writeFileSync(file, JSON.stringify(project));
    expect(() => retainEditingMedia(dir, file, evidence, replay)).toThrow();
    const map = JSON.parse(
      fs.readFileSync(
        path.join(evidence, `media-map-${path.basename(dir)}.json`),
        "utf8",
      ),
    );
    for (const name of ["selected-extra.wav", "unused-extra.wav"])
      expect(fs.readFileSync(map.media[name].retainedPath, "utf8")).toBe(name);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("retains other inputs and diagnostics for malformed tracks and escaped sources", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editing-invalid-media-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "editing-outside-"));
  try {
    const { project, file } = smallProject(dir);
    fs.mkdirSync(path.join(dir, "raw"));
    const evidence = path.join(dir, "evidence");
    fs.mkdirSync(evidence);
    fs.writeFileSync(
      path.join(dir, "raw", "kept.wav"),
      "literal retained bytes",
    );
    fs.writeFileSync(path.join(outside, "secret.wav"), "literal outside bytes");
    fs.symlinkSync(
      path.join(outside, "secret.wav"),
      path.join(dir, "escaped.wav"),
    );
    Object.assign(project.timeline, {
      tracks: [{ id: "malformed", media: null }],
    });
    Object.assign(project, {
      sources: [
        { id: "escaped", path: "escaped.wav" },
        { id: "malformed", path: null },
        { id: "missing", path: "missing.wav" },
      ],
    });
    fs.writeFileSync(file, JSON.stringify(project));
    expect(() => retainEditingMedia(dir, file, evidence, {})).toThrow();
    const map = JSON.parse(
      fs.readFileSync(
        path.join(evidence, `media-map-${path.basename(dir)}.json`),
        "utf8",
      ),
    );
    expect(
      fs.readFileSync(map.media["raw/kept.wav"].retainedPath, "utf8"),
    ).toBe("literal retained bytes");
    expect(map.failures.join(" ")).toContain("track");
    expect(map.failures.join(" ")).toContain("source 1");
    expect(map.failures.join(" ")).toContain("escapes workspace");
    expect(map.failures.join(" ")).toContain("missing.wav");
    expect(fs.readFileSync(path.join(outside, "secret.wav"), "utf8")).toBe(
      "literal outside bytes",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

it("constructs owned fixtures with exact source paths and original provenance", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editing-owned-fixture-"));
  const manifest = createE2eCleanupManifest();
  const previousReplay = process.env.EDITING_REPLAY_MEDIA;
  const previousManifest = process.env.DAW_E2E_CLEANUP_MANIFEST;
  try {
    const replay = Object.fromEntries(
      ["reference", "guest"].map((id) => {
        const bytes = fs.readFileSync(
          path.resolve(
            "../../tests/fixtures/aligned_dialogue/raw",
            `${id}.wav`,
          ),
        );
        const retainedPath = path.join(dir, `${id}.wav`);
        fs.writeFileSync(retainedPath, bytes);
        return [
          id,
          {
            relativePath: `raw/${id}.wav`,
            retainedPath,
            sha256: digest(bytes),
          },
        ];
      }),
    );
    const receipt = path.join(dir, "replay.json");
    fs.writeFileSync(receipt, JSON.stringify(replay));
    process.env.EDITING_REPLAY_MEDIA = receipt;
    process.env.DAW_E2E_CLEANUP_MANIFEST = manifest.manifestPath;
    for (const task of [editingTaskRegistry[0], editingTaskRegistry[7]]) {
      const fixture = createEditingFixture(task, dir);
      const name = path.basename(fixture.workspaceDir);
      const originalPath = path.join(
        dir,
        `fixture-${name}-initial-project.json`,
      );
      const originalBytes = fs.readFileSync(originalPath);
      const original = JSON.parse(originalBytes.toString());
      const sourcesBytes = fs.readFileSync(
        path.join(dir, `fixture-${name}-original-sources.json`),
      );
      const corrected = JSON.parse(
        fs.readFileSync(fixture.projectPath, "utf8"),
      );
      const proof = JSON.parse(
        fs.readFileSync(
          path.join(dir, `fixture-source-paths-${name}.json`),
          "utf8",
        ),
      );
      expect(proof.inputProjectHash).toBe(
        digest(
          fs.readFileSync(path.join(dir, `fixture-${name}-input-project.json`)),
        ),
      );
      expect(proof.originalHash).toBe(digest(originalBytes));
      expect(proof.originalSourcesHash).toBe(digest(sourcesBytes));
      expect(JSON.parse(sourcesBytes.toString())).toEqual(original.sources);
      expect(corrected.sources).toEqual(
        original.sources.map((source: Record<string, unknown>) => ({
          ...source,
          path:
            source.id === "reference_src0"
              ? "raw/reference.wav"
              : "raw/guest.wav",
        })),
      );
      expect(readEditingState(fixture.projectPath)).toEqual(task.start);
      const diagnostic = JSON.parse(
        fs.readFileSync(
          path.join(dir, `original-media-map-${name}.json`),
          "utf8",
        ),
      );
      expect(diagnostic.failures.join(" ")).toContain("reference.wav");
      expect(diagnostic.failures.join(" ")).toContain("guest.wav");
      for (const [index, id] of ["reference", "guest"].entries()) {
        expect(proof.sourcePaths[index]).toEqual({
          id: `${id}_src0`,
          originalPath: `${id}.wav`,
          path: `raw/${id}.wav`,
          resolvedPath: fs.realpathSync(
            path.join(fixture.workspaceDir, "raw", `${id}.wav`),
          ),
          sha256: replay[id].sha256,
          retainedPath: replay[id].retainedPath,
        });
        expect(
          fs.existsSync(path.join(fixture.workspaceDir, `${id}.wav`)),
        ).toBe(false);
      }
    }
    const invalid = structuredClone(editingTaskRegistry[0]);
    invalid.start.sources[0].path = "missing.wav";
    expect(() => createEditingFixture(invalid, dir)).toThrow(
      "Declared task source has no retained replay input",
    );
  } finally {
    if (previousReplay === undefined) delete process.env.EDITING_REPLAY_MEDIA;
    else process.env.EDITING_REPLAY_MEDIA = previousReplay;
    if (previousManifest === undefined)
      delete process.env.DAW_E2E_CLEANUP_MANIFEST;
    else process.env.DAW_E2E_CLEANUP_MANIFEST = previousManifest;
    await cleanupE2eManifest(manifest);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
