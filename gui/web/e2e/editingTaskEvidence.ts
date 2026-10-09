import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type HistoryIdentity, type TaskDefinition } from "./editingTaskReport";
import {
  type DurableState,
  type Json,
  parseDurableState,
} from "./editingTaskState";
import { committedE2eProjectPath } from "./env";
import { createRelocatedE2eProject } from "./liveProject";

function object(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("Expected saved object");
  return input as Record<string, unknown>;
}
function array(input: unknown): unknown[] {
  if (!Array.isArray(input)) throw new Error("Expected saved array");
  return input;
}
function json(input: unknown): Json {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "boolean" ||
    (typeof input === "number" && Number.isFinite(input))
  )
    return input;
  if (Array.isArray(input)) return input.map(json);
  return Object.fromEntries(
    Object.entries(object(input)).map(([key, value]) => [key, json(value)]),
  );
}
function fields(input: unknown, keys: string[]): Record<string, Json> {
  const row = object(input);
  return Object.fromEntries(keys.map((key) => [key, json(row[key])]));
}
export function readEditingState(
  projectPath: string,
  normalizeCut = false,
  identities: Record<string, string> = {},
): DurableState {
  const saved = object(JSON.parse(fs.readFileSync(projectPath, "utf8")));
  const timeline = object(saved.timeline);
  const clips = array(timeline.clips).map((row) =>
    fields(row, [
      "id",
      "track_id",
      "source_start",
      "source_end",
      "timeline_start",
      "source_id",
      "fade_in_ms",
      "fade_out_ms",
      "join_in_mode",
      "mute_regions",
    ]),
  );
  if (new Set(clips.map((row) => row.id)).size !== clips.length)
    throw new Error("Raw saved clip IDs are not unique");
  for (const row of clips) {
    if (typeof row.id !== "string") throw new Error("Invalid raw clip ID");
    const raw = row.id;
    if (
      normalizeCut &&
      row.track_id === "reference" &&
      row.id !== "first-copy" &&
      row.id !== "second-copy"
    ) {
      if (
        row.source_start === 0 &&
        row.source_end === 1 &&
        row.timeline_start === 10
      )
        row.id = "cut-left";
      else if (
        row.source_start === 2 &&
        row.source_end === 5 &&
        row.timeline_start === 12
      )
        row.id = "cut-right";
    }
    identities[raw] = row.id;
  }
  return parseDurableState({
    duration_sec: json(timeline.duration_sec),
    sources: array(saved.sources).map((source) => {
      const row = object(source);
      if (typeof row.path !== "string")
        throw new Error("Invalid durable source identity");
      return {
        ...fields(row, [
          "id",
          "speaker",
          "label",
          "offset_sec",
          "duration_sec",
          "sample_rate",
          "channels",
          "clipping_regions",
          "clipping_truncated",
        ]),
        path: path
          .relative(
            path.dirname(projectPath),
            path.resolve(path.dirname(projectPath), row.path),
          )
          .split(path.sep)
          .join("/"),
      };
    }),
    stable: {
      ...fields(saved.editorial, [
        "chapters",
        "speaker_splits",
        "retained_bleed_alignments",
      ]),
      ...fields(saved.mix, ["processing_chains"]),
      social: json(saved.social),
      review_versions: json(object(saved.review).versions),
      active_version_id: json(object(saved.review).active_version_id),
    },
    clips,
    tracks: array(timeline.tracks).map((row) => ({
      ...fields(row, ["id", "fader_db", "gain_db", "muted", "role"]),
      media: json({
        ...object(object(row).media),
        path: path
          .relative(
            path.dirname(projectPath),
            path.resolve(
              path.dirname(projectPath),
              String(object(object(row).media).path),
            ),
          )
          .split(path.sep)
          .join("/"),
      }),
      invariants: json(
        Object.fromEntries(
          Object.entries(object(row)).filter(
            ([key]) =>
              !["id", "fader_db", "gain_db", "muted", "role", "media"].includes(
                key,
              ),
          ),
        ),
      ),
    })),
    envelopes: array(object(saved.mix).automation_envelopes).map(json),
    comments: array(object(saved.review).comments).map((input) => {
      const row = object(input);
      return {
        ...fields(row, [
          "id",
          "body",
          "author",
          "timeline_start",
          "timeline_end",
          "track_ids",
          "resolved",
        ]),
        resolved_by: json(
          row.resolved_by === undefined ? null : row.resolved_by,
        ),
        review_version_id: json(
          row.review_version_id === undefined ? null : row.review_version_id,
        ),
        edit_decision_id: json(
          row.edit_decision_id === undefined ? null : row.edit_decision_id,
        ),
        timeline_spans: array(
          row.timeline_spans === undefined ? [] : row.timeline_spans,
        ).map((span) => fields(span, ["start", "end"])),
        action_items: array(
          row.action_items === undefined ? [] : row.action_items,
        ).map((input) => {
          const item = object(input);
          return {
            ...fields(item, ["id", "text"]),
            done: json(item.done === undefined ? false : item.done),
            completed_by: json(
              item.completed_by === undefined ? null : item.completed_by,
            ),
          };
        }),
        replies: array(row.replies === undefined ? [] : row.replies).map(
          (reply) => fields(reply, ["id", "body", "author"]),
        ),
      };
    }),
  });
}
export function retainEditingMedia(
  workspaceDir: string,
  projectPath: string,
  evidenceDir: string,
  replay: Record<
    string,
    { relativePath: string; retainedPath: string; sha256: string }
  >,
) {
  const saved = object(JSON.parse(fs.readFileSync(projectPath, "utf8")));
  const failures: string[] = [];
  const declared = new Set<string>();
  const addPath = (input: unknown, label: string) => {
    if (typeof input !== "string" || !input.trim()) {
      failures.push(`Invalid declared media path ${label}`);
      return;
    }
    const relativePath = path.relative(
      workspaceDir,
      path.resolve(workspaceDir, input),
    );
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      failures.push(`Declared media escapes workspace ${label}: ${input}`);
      return;
    }
    declared.add(relativePath.split(path.sep).join("/"));
  };
  try {
    for (const [index, input] of array(
      object(saved.timeline).tracks,
    ).entries()) {
      try {
        const row = object(input);
        addPath(object(row.media).path, `track ${index} ${String(row.id)}`);
      } catch (error) {
        failures.push(`Invalid declared track ${index}: ${String(error)}`);
      }
    }
  } catch (error) {
    failures.push(`Invalid declared track inventory: ${String(error)}`);
  }
  if (!Array.isArray(saved.sources))
    failures.push("Invalid declared source inventory");
  else
    for (const [index, source] of saved.sources.entries()) {
      try {
        addPath(object(source).path, `source ${index}`);
      } catch (error) {
        failures.push(`Invalid declared source ${index}: ${String(error)}`);
      }
    }
  const rawDir = path.join(workspaceDir, "raw");
  const census = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      const relative = path.relative(
        fs.realpathSync(workspaceDir),
        fs.realpathSync(dir),
      );
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error("Raw media directory escapes workspace");
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      failures.push(`Raw media census ${dir}: ${String(error)}`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) census(full);
      else if (/\.(wav|mp3|flac|m4a|ogg|aac)$/i.test(entry.name))
        declared.add(
          path.relative(workspaceDir, full).split(path.sep).join("/"),
        );
    }
  };
  if (fs.existsSync(rawDir)) census(rawDir);
  const files = new Set(Object.values(replay).map((row) => row.relativePath));
  const media: Record<
    string,
    { copiedPath: string; retainedPath: string; sha256: string }
  > = {};
  const entries = [
    ...Object.entries(replay),
    ...Array.from(declared)
      .filter((file) => !files.has(file))
      .map(
        (file) =>
          [file, { relativePath: file, retainedPath: "", sha256: "" }] as const,
      ),
  ];
  for (const [id, receipt] of entries) {
    const copiedPath = path.resolve(workspaceDir, receipt.relativePath);
    try {
      const resolvedPath = fs.realpathSync(copiedPath);
      const relative = path.relative(
        fs.realpathSync(workspaceDir),
        resolvedPath,
      );
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error("Media path escapes workspace");
      const bytes = fs.readFileSync(resolvedPath);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      let retainedPath = receipt.retainedPath;
      if (
        !declared.has(receipt.relativePath) ||
        sha256 !== receipt.sha256 ||
        !retainedPath ||
        !fs.existsSync(retainedPath) ||
        createHash("sha256")
          .update(fs.readFileSync(retainedPath))
          .digest("hex") !== sha256
      ) {
        retainedPath = path.join(
          evidenceDir,
          `unique-media-${path.basename(workspaceDir)}-${sha256}.wav`,
        );
        fs.writeFileSync(retainedPath, bytes);
        fs.writeFileSync(
          `${retainedPath}.json`,
          JSON.stringify(
            { copiedPath, retainedPath, sha256, expected: receipt },
            null,
            2,
          ),
        );
        failures.push(`Replay media differs for ${id}`);
      }
      media[id] = { copiedPath, retainedPath, sha256 };
    } catch (error) {
      failures.push(`Media ${id}: ${String(error)}`);
    }
  }
  fs.writeFileSync(
    path.join(evidenceDir, `media-map-${path.basename(workspaceDir)}.json`),
    JSON.stringify({ projectPath, media, failures }, null, 2),
  );
  if (failures.length) throw new Error(failures.join("; "));
  return media;
}
export function verifyEditingDistribution(
  dist: string,
  assets: Record<string, string>,
) {
  const actual: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else
        actual[path.relative(dist, file).split(path.sep).join("/")] =
          createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    }
  };
  visit(dist);
  if (
    !assets ||
    !Object.keys(assets).length ||
    !assets["index.html"] ||
    JSON.stringify(Object.keys(actual).sort()) !==
      JSON.stringify(Object.keys(assets).sort())
  )
    throw new Error("Dist asset inventory differs");
  for (const [file, sha256] of Object.entries(actual))
    if (assets[file] !== sha256) throw new Error(`Dist asset mismatch ${file}`);
  return actual;
}
export function createEditingFixture(
  task: TaskDefinition,
  evidenceDir: string,
) {
  const inputProjectBytes = fs.readFileSync(committedE2eProjectPath);
  const inputProjectHash = createHash("sha256")
    .update(inputProjectBytes)
    .digest("hex");
  const fixture = createRelocatedE2eProject("sharecut-e2e-editing-task-");
  fs.writeFileSync(
    path.join(
      evidenceDir,
      `fixture-${path.basename(fixture.workspaceDir)}-input-project.json`,
    ),
    inputProjectBytes,
  );
  fs.copyFileSync(
    fixture.projectPath,
    path.join(
      evidenceDir,
      `fixture-${path.basename(fixture.workspaceDir)}-initial-project.json`,
    ),
  );
  const replay = JSON.parse(
    fs.readFileSync(process.env.EDITING_REPLAY_MEDIA!, "utf8"),
  ) as Record<
    string,
    { relativePath: string; retainedPath: string; sha256: string }
  >;
  const saved = object(
    JSON.parse(fs.readFileSync(fixture.projectPath, "utf8")),
  );
  const originalSources = array(saved.sources);
  const originalHash = createHash("sha256")
    .update(fs.readFileSync(fixture.projectPath))
    .digest("hex");
  const originalSourceJson = `${JSON.stringify(originalSources, null, 2)}\n`;
  const originalSourcesHash = createHash("sha256")
    .update(originalSourceJson)
    .digest("hex");
  fs.writeFileSync(
    path.join(
      evidenceDir,
      `fixture-${path.basename(fixture.workspaceDir)}-original-sources.json`,
    ),
    originalSourceJson,
  );
  try {
    retainEditingMedia(
      fixture.workspaceDir,
      fixture.projectPath,
      evidenceDir,
      replay,
    );
  } catch (error) {
    fs.renameSync(
      path.join(
        evidenceDir,
        `media-map-${path.basename(fixture.workspaceDir)}.json`,
      ),
      path.join(
        evidenceDir,
        `original-media-map-${path.basename(fixture.workspaceDir)}.json`,
      ),
    );
    fs.writeFileSync(
      path.join(
        evidenceDir,
        `original-media-diagnostic-${path.basename(fixture.workspaceDir)}.json`,
      ),
      JSON.stringify(
        {
          originalHash,
          originalSourcesHash,
          sources: originalSources,
          error: String(error),
        },
        null,
        2,
      ),
    );
  }
  const sourcePaths = originalSources.map((input) => {
    const source = object(input);
    const fixtureSource =
      source.id === "reference_src0"
        ? "reference"
        : source.id === "guest_src0"
          ? "guest"
          : null;
    if (!fixtureSource || source.path !== `${fixtureSource}.wav`)
      throw new Error("Unexpected original fixture source path or identity");
    const target = task.start.sources.find((row) => row.id === source.id);
    const receipt = replay[fixtureSource];
    if (
      !target ||
      target.path !== `raw/${fixtureSource}.wav` ||
      receipt?.relativePath !== target.path
    )
      throw new Error("Declared task source has no retained replay input");
    const resolvedPath = fs.realpathSync(
      path.resolve(fixture.workspaceDir, target.path),
    );
    const sha256 = createHash("sha256")
      .update(fs.readFileSync(resolvedPath))
      .digest("hex");
    if (sha256 !== receipt.sha256)
      throw new Error("Declared task source differs from replay input");
    return {
      id: source.id,
      originalPath: source.path,
      path: target.path,
      resolvedPath,
      sha256,
      retainedPath: receipt.retainedPath,
    };
  });
  saved.sources = originalSources.map((input) => {
    const source = object(input);
    return {
      ...source,
      path: sourcePaths.find((row) => row.id === source.id)!.path,
    };
  });
  fs.writeFileSync(fixture.projectPath, `${JSON.stringify(saved, null, 2)}\n`);
  retainEditingMedia(
    fixture.workspaceDir,
    fixture.projectPath,
    evidenceDir,
    replay,
  );
  fs.writeFileSync(
    path.join(
      evidenceDir,
      `fixture-source-paths-${path.basename(fixture.workspaceDir)}.json`,
    ),
    JSON.stringify(
      { inputProjectHash, originalHash, originalSourcesHash, sourcePaths },
      null,
      2,
    ),
  );
  const timeline = object(saved.timeline);
  if (array(timeline.tracks).some((row) => object(row).role !== "dialogue"))
    throw new Error("Ripple task requires both dialogue tracks");
  timeline.clips = task.start.clips;
  timeline.duration_sec = 20;
  for (const track of array(timeline.tracks))
    Object.assign(
      object(track),
      fields(
        task.start.tracks.find((row) => row.id === object(track).id),
        ["id", "fader_db", "gain_db", "muted"],
      ),
    );
  object(saved.mix).automation_envelopes = task.start.envelopes;
  object(saved.review).comments = task.start.comments.map((row) => ({
    ...row,
    created_at: "2026-01-01T00:00:00Z",
  }));
  object(saved.editorial).edit_decisions = [];
  object(saved.editorial).edit_log = [];
  fs.writeFileSync(fixture.projectPath, `${JSON.stringify(saved, null, 2)}\n`);
  return fixture;
}

export function readEditingHistory(projectPath: string): HistoryIdentity {
  const project = object(JSON.parse(fs.readFileSync(projectPath, "utf8")));
  const saved = object(project.history);
  const cursor = saved.cursor;
  const entries = array(saved.entries).map((entry) => {
    const row = object(entry);
    if (
      typeof row.id !== "string" ||
      typeof row.label !== "string" ||
      !(row.operation === null || typeof row.operation === "string")
    )
      throw new Error("Malformed saved history entry");
    return { id: row.id, label: row.label, operation: row.operation };
  });
  if (
    typeof cursor !== "number" ||
    !Number.isSafeInteger(cursor) ||
    cursor < -1 ||
    cursor >= entries.length
  )
    throw new Error("Malformed saved history cursor");
  return { cursor, headId: cursor >= 0 ? entries[cursor].id : null, entries };
}

export function verifyEditingBackend(
  output: string,
  port: string | undefined,
  expected: { cwd: string; productionDist?: string; shareRegistry?: string },
): void {
  if (process.platform === "linux") {
    const processes = fs
      .readdirSync("/proc")
      .filter((pid) => /^\d+$/.test(pid))
      .flatMap((pid) => {
        try {
          const command = fs
            .readFileSync(`/proc/${pid}/cmdline`, "utf8")
            .split("\0")
            .filter(Boolean);
          const portIndex = command.indexOf("--port");
          if (
            portIndex < 0 ||
            command[portIndex + 1] !== port ||
            !command.includes("gui")
          )
            return [];
          const executable = fs.readlinkSync(`/proc/${pid}/exe`);
          if (!path.basename(executable).startsWith("python")) return [];
          const environment = Object.fromEntries(
            fs
              .readFileSync(`/proc/${pid}/environ`, "utf8")
              .split("\0")
              .filter(Boolean)
              .map((entry) => {
                const at = entry.indexOf("=");
                return [entry.slice(0, at), entry.slice(at + 1)];
              }),
          );
          return [
            {
              pid: Number(pid),
              command,
              executable,
              cwd: fs.readlinkSync(`/proc/${pid}/cwd`),
              productionDist: environment.PODCAST_GUI_DIST,
              shareRegistry: environment.PODCAST_SHARE_REGISTRY,
            },
          ];
        } catch {
          return [];
        }
      });
    fs.writeFileSync(
      path.join(output, "live-backend.json"),
      JSON.stringify(processes, null, 2),
    );
    if (
      processes.length !== 1 ||
      processes[0].cwd !== expected.cwd ||
      processes[0].productionDist !== expected.productionDist ||
      processes[0].shareRegistry !== expected.shareRegistry
    )
      throw new Error(
        "Live backend process provenance differs from admitted source/build/isolation",
      );
  }
}
