import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type CDPSession,
  expect,
  type Locator,
  type Page,
  type Request,
  type Response,
  type TestInfo,
} from "@playwright/test";
import { niceTimeStep } from "../src/utils/time";
import {
  assessEditingTrial,
  type DurableState,
  type EditingTrial,
  type JournalEvent,
  type Json,
  type Phase,
  parseDurableState,
  savedStateDifferences,
  type TaskDefinition,
  type TaskRoute,
} from "./editingTaskReport";
import { createEditorProfiler } from "./editorProfile";
import { createRelocatedE2eProject } from "./liveProject";
import { switchE2eProject } from "./shareableProject";

const clip = {
  track_id: "reference",
  source_start: 0,
  source_end: 5,
  timeline_start: 0,
  source_id: null,
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
  mute_regions: [],
};
const trackInvariants = {
  label: "reference",
  speaker: "reference",
  room_tone: null,
  gate_fill: null,
  balance_basis: null,
  transcript_gate: false,
  transcript_gate_scope: null,
  proxy: null,
  timeline_empty: false,
};
const base: DurableState = {
  duration_sec: 20,
  sources: [
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
    {
      id: "guest_src0",
      path: "guest.wav",
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
  stable: {
    chapters: [],
    speaker_splits: [],
    retained_bleed_alignments: [],
    processing_chains: [],
    social: { clip_candidates: [] },
    review_versions: [],
    active_version_id: null,
  },
  clips: [
    { ...clip, id: "first-copy" },
    { ...clip, id: "second-copy", timeline_start: 10 },
    { ...clip, id: "peer", track_id: "guest", source_end: 20 },
  ],
  tracks: [
    {
      id: "reference",
      fader_db: 0,
      gain_db: 0,
      muted: false,
      role: "dialogue",
      media: {
        path: "raw/reference.wav",
        duration_sec: 60,
        sample_rate: 48000,
        channels: 1,
      },
      invariants: trackInvariants,
    },
    {
      id: "guest",
      fader_db: 0,
      gain_db: 0,
      muted: false,
      role: "dialogue",
      media: {
        path: "raw/guest.wav",
        duration_sec: 60,
        sample_rate: 48000,
        channels: 1,
      },
      invariants: { ...trackInvariants, label: "guest", speaker: "guest" },
    },
  ],
  envelopes: [],
  comments: [],
};
function route(
  id: string,
  input: "pointer" | "keyboard" | "numeric" | "cdp-touch",
  command: string | null,
  cancel = false,
  undo: "history" | "comment-toast" | "none" = "history",
  mutations = 1,
): TaskRoute {
  return { id, input, command, cancel, undo, mutations };
}
const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };
const envelopeStart: DurableState = {
  ...base,
  envelopes: [
    {
      track_id: "reference",
      parameter: "volume",
      points: [
        { id: "p1", time: 2, value: 0.6 },
        { id: "p2", time: 10, value: 1.4 },
      ],
    },
  ],
};
const commentStart: DurableState = {
  ...base,
  comments: [
    {
      id: "task-comment",
      body: "Editing task comment",
      author: "Host",
      timeline_start: 2,
      timeline_end: null,
      track_ids: [],
      resolved: false,
    },
  ],
};
export const editingTaskRegistry: TaskDefinition[] = [
  {
    id: "seek",
    family: "seek",
    viewport: desktop,
    start: base,
    expected: base,
    seek: 5,
    tolerances: {},
    routes: [
      route("ruler-pointer", "pointer", null, false, "none", 0),
      route("ruler-keyboard", "keyboard", null, false, "none", 0),
      {
        id: "timestamp",
        pending: "TimeRulerView has no exact timestamp entry",
      },
    ],
  },
  {
    id: "range-cut",
    historyLabels: {
      before: "before selected range",
      after: "after selected range",
    },
    historyOperation: "edit_selected_range",
    family: "range-cut",
    viewport: desktop,
    start: base,
    expected: {
      ...base,
      clips: [
        { ...clip, id: "first-copy" },
        {
          ...clip,
          id: "cut-left",
          source_end: 1,
          timeline_start: 10,
          fade_out_ms: 10,
        },
        {
          ...clip,
          id: "cut-right",
          source_start: 2,
          timeline_start: 12,
          fade_in_ms: 10,
        },
        base.clips[2],
      ],
    },
    tolerances: {},
    routes: [
      route("armed-pointer", "pointer", "EditSelectedRange", true),
      route("range-form", "numeric", "EditSelectedRange", true),
    ],
  },
  {
    id: "trim",
    historyLabels: {
      before: "before trim clip edge",
      after: "after trim clip edge",
    },
    historyOperation: "trim_clip_edge",
    family: "trim-fade",
    editMode: "ripple",
    viewport: desktop,
    start: base,
    expected: {
      ...base,
      duration_sec: 19.7,
      clips: [
        { ...base.clips[0], source_start: 0.3 },
        { ...base.clips[1], timeline_start: 9.7 },
        { ...base.clips[2], source_start: 0.3 },
      ],
    },
    tolerances: {
      "after.duration_sec": 0.03,
      "after.clips.first-copy.source_start": 0.03,
      "after.clips.second-copy.timeline_start": 0.03,
      "after.clips.peer.source_start": 0.03,
    },
    routes: [
      route("handle-pointer", "pointer", "TrimClipEdge", true),
      route("handle-keyboard", "keyboard", "TrimClipEdge", true),
      {
        id: "numeric-trim",
        pending: "ClipInspector Source is text; no numeric trim input",
      },
    ],
  },
  {
    id: "fade",
    historyLabels: {
      before: "before set clip fade",
      after: "after set clip fade",
    },
    historyOperation: "set_clip_fade",
    family: "trim-fade",
    viewport: desktop,
    start: base,
    expected: {
      ...base,
      clips: [
        { ...base.clips[0], fade_in_ms: 40 },
        base.clips[1],
        base.clips[2],
      ],
    },
    tolerances: { "after.clips.first-copy.fade_in_ms": 1 },
    routes: [
      route("corner-pointer", "pointer", "SetClipFade", true),
      route("inspector-slider", "keyboard", "SetClipFade", true),
    ],
  },
  {
    id: "envelope",
    historyLabels: {
      before: "before set envelope",
      after: "after set envelope reference",
    },
    historyOperation: null,
    family: "envelope",
    viewport: desktop,
    start: envelopeStart,
    expected: {
      ...base,
      envelopes: [
        {
          track_id: "reference",
          parameter: "volume",
          points: [
            { id: "p1", time: 6, value: 0.8 },
            { id: "p2", time: 10, value: 1.4 },
          ],
        },
      ],
    },
    tolerances: {
      "after.envelopes.0.points.0.time": 0.03,
      "after.envelopes.0.points.0.value": 0.02,
    },
    routes: [
      route("point-pointer", "pointer", "SetEnvelope", true),
      route("point-form", "numeric", "SetEnvelope", true),
      route("point-form-tab-header", "numeric", "SetEnvelope", true),
    ],
  },
  {
    id: "reorder",
    historyLabels: {
      before: "before reorder track guest",
      after: "after reorder track guest",
    },
    historyOperation: "reorder_track",
    family: "reorder",
    viewport: desktop,
    start: base,
    expected: { ...base, tracks: [base.tracks[1], base.tracks[0]] },
    tolerances: {},
    routes: [
      route("html-drag", "pointer", "ReorderTrack", true),
      route("move-up", "pointer", "ReorderTrack"),
      route("move-up-tab-header", "pointer", "ReorderTrack"),
    ],
  },
  {
    id: "mix",
    historyLabels: {
      before: "before set track volume reference",
      after: "after set track volume reference",
    },
    historyOperation: "set_track_volume",
    family: "mix",
    viewport: phone,
    start: base,
    expected: {
      ...base,
      tracks: [{ ...base.tracks[0], fader_db: -6 }, base.tracks[1]],
    },
    tolerances: { "after.tracks.0.fader_db": 0.25 },
    routes: [
      route("native-pointer", "pointer", "SetTrackFader", true),
      route(
        "native-keyboard",
        "keyboard",
        "SetTrackFader",
        false,
        "history",
        12,
      ),
      {
        id: "precise-field",
        pending: "TrackMixView has no precise numeric field or stepper",
      },
    ],
  },
  {
    id: "comment",
    family: "comment",
    viewport: phone,
    start: commentStart,
    expected: {
      ...commentStart,
      comments: [{ ...commentStart.comments[0], resolved: true }],
    },
    tolerances: {},
    routes: [
      route(
        "resolve-button",
        "pointer",
        "ResolveComment",
        false,
        "comment-toast",
      ),
      route(
        "trusted-touch-swipe",
        "cdp-touch",
        "ResolveComment",
        true,
        "comment-toast",
      ),
    ],
  },
];
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
    comments: array(object(saved.review).comments).map((row) =>
      fields(row, [
        "id",
        "body",
        "author",
        "timeline_start",
        "timeline_end",
        "track_ids",
        "resolved",
      ]),
    ),
  });
}
export async function editingResponseOutcome(
  response: Response,
  request: { id: number; phase: Phase; kind: "command" | "read" },
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = await Promise.race([
      response.text(),
      new Promise<string>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Editing response body drain timed out")),
          5000,
        );
      }),
    ]);
    return {
      phase: request.phase,
      kind:
        request.kind === "read"
          ? ("read-response" as const)
          : ("response" as const),
      requestId: request.id,
      status: response.status(),
      body,
    };
  } catch (error) {
    return request.kind === "read"
      ? {
          phase: request.phase,
          kind: "read-body-failed" as const,
          requestId: request.id,
          status: response.status(),
          error: String(error),
        }
      : {
          phase: request.phase,
          kind: "error" as const,
          message: `response ${request.id}: ${String(error)}`,
        };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function navigateEditingTimeline(
  active: Page,
  activate: (control: Locator, label: string) => Promise<unknown>,
) {
  if (!(await active.locator(".timeline-scroll").isVisible()))
    await activate(
      active
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "Timeline", exact: true }),
      "Primary Timeline",
    );
  await active.locator(".timeline-scroll").waitFor({ state: "visible" });
}
export async function tabToEditingControl(
  control: Locator,
  press: (key: string) => Promise<unknown>,
) {
  for (
    let index = 0;
    index < 80 &&
    !(await control.evaluate((element) => document.activeElement === element));
    index++
  )
    await press("Tab");
  if (
    !(await control.evaluate((element) => document.activeElement === element))
  )
    throw new Error("Track header not reached by Tab");
  await press("Enter");
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
  const declared = new Set(
    array(object(saved.timeline).tracks).map((row) =>
      String(object(object(row).media).path),
    ),
  );
  const rawDir = path.join(workspaceDir, "raw");
  const census = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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
  const failures: string[] = [];
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
      const bytes = fs.readFileSync(copiedPath);
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
  const fixture = createRelocatedE2eProject("sharecut-e2e-editing-task-");
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
  retainEditingMedia(
    fixture.workspaceDir,
    fixture.projectPath,
    evidenceDir,
    replay,
  );
  const saved = object(
    JSON.parse(fs.readFileSync(fixture.projectPath, "utf8")),
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

export async function runEditingTask(
  page: Page,
  cdp: CDPSession,
  info: TestInfo,
  task: TaskDefinition,
  routeId: string,
  output: string,
  mode: EditingTrial["mode"],
): Promise<EditingTrial> {
  const chosen = task.routes.find((row) => row.id === routeId);
  if (!chosen || "pending" in chosen)
    throw new Error("Only current supported routes can execute");
  fs.mkdirSync(output, { recursive: true });
  const trial: EditingTrial = {
    task: task.id,
    route: routeId,
    mode,
    journal: [],
    errors: [],
    protocolHash: process.env.EDITING_PROTOCOL_HASH,
    definitionHash: createHash("sha256")
      .update(JSON.stringify(task))
      .digest("hex"),
    role: "host",
    artifacts: [],
  };
  let phase: Phase = "setup";
  let sequence = 0;
  const retain = () =>
    fs.writeFileSync(
      path.join(output, "trial.json"),
      `${JSON.stringify(trial, null, 2)}\n`,
    );
  const captureUi = async (active: Page, stage: string, screenshot = true) => {
    const geometry = await active
      .locator(
        '[data-clip-id], [role="slider"], input[type="range"], .comment-card, svg circle',
      )
      .evaluateAll((elements) => ({
        focused: {
          tag: document.activeElement?.tagName ?? null,
          label: document.activeElement?.getAttribute("aria-label") ?? null,
          className: document.activeElement?.getAttribute("class") ?? null,
        },
        elements: elements.map((element) => {
          const box = element.getBoundingClientRect();
          return {
            tag: element.tagName,
            id: element.getAttribute("data-clip-id"),
            label: element.getAttribute("aria-label"),
            value:
              element.getAttribute("aria-valuenow") ??
              (element instanceof HTMLInputElement ? element.value : null),
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            transform: element.getAttribute("style"),
          };
        }),
      }));
    const evidence: NonNullable<EditingTrial["uiEvidence"]>[number] = {
      stage,
      phase,
      geometry,
    };
    if (mode !== "baseline" && screenshot) {
      evidence.screenshot = `ui-${trial.uiEvidence?.length ?? 0}-${stage}.png`;
      await active.screenshot({
        path: path.join(output, evidence.screenshot),
        fullPage: true,
      });
      trial.artifacts!.push(evidence.screenshot);
    }
    (trial.uiEvidence ??= []).push(evidence);
    retain();
  };
  const append = (
    event:
      | { kind: "error"; message: string }
      | { kind: "request"; requestId: number; type: string; body: string }
      | { kind: "read-request"; requestId: number; url: string; method: string }
      | {
          kind: "read-response";
          requestId: number;
          status: number;
          body: string;
        }
      | { kind: "read-failed"; requestId: number; error: string },
  ) => {
    trial.journal.push({ ...event, seq: ++sequence, phase } as JournalEvent);
    retain();
  };
  const responses: Promise<void>[] = [];
  const pending = new Map<Page, Set<Request>>();
  const flush = async (active: Page) => {
    await active.waitForLoadState("networkidle", { timeout: 5000 });
    await expect
      .poll(() => pending.get(active)?.size ?? 0, {
        timeout: 5000,
        message: "Pending editing requests did not reach terminal outcomes",
      })
      .toBe(0);
    await Promise.all(responses);
  };
  const observe = (observedPage: Page) => {
    const inflight = new Set<Request>();
    pending.set(observedPage, inflight);
    observedPage.on("requestfinished", (request) => inflight.delete(request));
    const requests = new Map<
      Request,
      { id: number; phase: Phase; kind: "command" | "read" }
    >();
    observedPage.on("pageerror", (error) =>
      append({ kind: "error", message: error.message }),
    );
    observedPage.on("request", (request) => {
      const url = new URL(request.url());
      if (
        request.method() === "GET" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        url.pathname.startsWith("/api/")
      ) {
        const id = sequence + 1;
        requests.set(request, { id, phase, kind: "read" });
        inflight.add(request);
        append({
          kind: "read-request",
          requestId: id,
          url: request.url(),
          method: request.method(),
        });
        return;
      }
      if (
        request.method() !== "POST" ||
        !new URL(request.url()).pathname.includes("/document/command")
      )
        return;
      const body = request.postData() ?? "";
      let type = "unknown";
      try {
        const parsed = object(JSON.parse(body));
        type = typeof parsed.type === "string" ? parsed.type : "unknown";
      } catch {}
      const id = sequence + 1;
      requests.set(request, { id, phase, kind: "command" });
      inflight.add(request);
      append({ kind: "request", requestId: id, type, body });
    });
    observedPage.on("response", (response) => {
      const url = new URL(response.url());
      if (
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        response.status() >= 400
      ) {
        append({
          kind: "error",
          message: `HTTP ${response.status()} ${response.request().method()} ${response.url()}`,
        });
        responses.push(
          response
            .text()
            .then((body) =>
              append({
                kind: "error",
                message: `HTTP error body ${response.url()} ${body}`,
              }),
            )
            .catch((error) =>
              append({
                kind: "error",
                message: `HTTP error body unavailable ${response.url()} ${String(error)}`,
              }),
            ),
        );
      }
      const request = requests.get(response.request());
      if (!request) return;
      responses.push(
        editingResponseOutcome(response, request).then((outcome) => {
          trial.journal.push({ ...outcome, seq: ++sequence });
          retain();
        }),
      );
    });
    observedPage.on("requestfailed", (request) => {
      inflight.delete(request);
      const read = requests.get(request);
      if (read?.kind === "read") {
        trial.journal.push({
          seq: ++sequence,
          phase: read.phase,
          kind: "read-failed",
          requestId: read.id,
          error: request.failure()?.errorText ?? "unknown",
        });
        retain();
        return;
      }
      if (
        ["127.0.0.1", "localhost", "[::1]"].includes(
          new URL(request.url()).hostname,
        )
      )
        append({
          kind: "error",
          message: `request failed ${request.method()} ${request.url()} ${request.failure()?.errorText}`,
        });
    });
  };
  const act = async (
    verb: string,
    label: string,
    action: () => Promise<unknown>,
  ) => {
    const event: JournalEvent = {
      seq: ++sequence,
      phase,
      kind: "activation",
      verb,
      label,
      outcome: "started",
    };
    trial.journal.push(event);
    retain();
    try {
      await action();
      event.outcome = "completed";
    } catch (error) {
      event.outcome = "failed";
      event.error = String(error);
      throw error;
    } finally {
      retain();
    }
  };
  const click = (control: Locator, label: string) =>
    act("click", label, () => control.click());
  const fill = (control: Locator, value: string, label: string) =>
    act("fill", label, () => control.fill(value));
  const key = (active: Page, value: string) =>
    act("key", value, () => active.keyboard.press(value));
  const focus = (control: Locator, label: string) =>
    act("focus", label, () => control.focus());
  const drag = async (
    active: Page,
    control: Locator,
    dx: number,
    dy: number,
    cancel: boolean,
  ) => {
    const box = await control.boundingBox();
    if (!box) throw new Error("Drag control has no geometry");
    await act(
      "drag",
      `${task.id} ${cancel ? "cancel" : "commit"}`,
      async () => {
        const x = box.x + box.width / 2,
          y = box.y + box.height / 2;
        await active.mouse.move(x, y);
        await active.mouse.down();
        await active.mouse.move(x + dx, y + dy, { steps: 10 });
        await captureUi(active, "intermediate-drag");
        if (cancel) await active.keyboard.press("Escape");
        await active.mouse.up();
      },
    );
  };
  const prepare = async (active: Page, projectPath: string) => {
    phase = "setup";
    await active.setViewportSize(task.viewport);
    await active.emulateMedia({
      reducedMotion: "reduce",
      colorScheme: "light",
    });
    await switchE2eProject(projectPath);
    await active.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await expect(active.locator(".daw-shell")).toBeVisible();
    await active.waitForLoadState("networkidle");
    await active.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    await navigateEditingTimeline(active, click);
    await captureUi(active, "timeline-ready");
    await act("click", "prepare timeline focus", () =>
      active.locator(".timeline-scroll").click({ position: { x: 2, y: 2 } }),
    );
    await act("key", "prepare fixed zoom one step", () =>
      active.keyboard.press("="),
    );
  };
  const openTrack = async (active: Page, label: string) => {
    const control = active.getByRole("button", {
      name: `Open track details, ${label}`,
      exact: true,
    });
    if (routeId.endsWith("-tab-header")) {
      await tabToEditingControl(control, (value) => key(active, value));
    } else await click(control, `${label} details`);
  };
  const perform = async (
    active: Page,
    session: CDPSession,
    cancel: boolean,
    cancelProbe = "short",
  ) => {
    const first = active.locator('[data-clip-id="first-copy"]');
    const firstBox = await first.boundingBox();
    const scale = firstBox ? firstBox.width / 5 : 0;
    if (task.id === "seek") {
      const ruler = active.getByRole("slider", {
        name: "Timeline position",
        exact: true,
      });
      if (routeId === "ruler-pointer")
        await act("click", "ruler at 5 seconds", () =>
          ruler.click({ position: { x: 5 * scale, y: 10 } }),
        );
      else {
        await focus(ruler, "ruler");
        await key(active, "Home");
        const step = niceTimeStep(scale);
        if (Math.abs(5 / step - Math.round(5 / step)) > 1e-9)
          throw new Error(`Frozen ruler step ${step} cannot reach literal5`);
        for (let index = 0; index < Math.round(5 / step); index++)
          await key(active, "ArrowRight");
      }
      return;
    }
    if (task.id === "range-cut") {
      if (routeId === "range-form") {
        await click(
          active.getByRole("button", { name: "Menu", exact: true }),
          "transport Menu",
        );
        await click(
          active.getByRole("menuitem", { name: "Select a range", exact: true }),
          "Select a range",
        );
        const range = active.getByRole("region", { name: "Range actions" });
        await fill(
          range.getByRole("spinbutton", { name: "In", exact: true }),
          "11",
          "range In",
        );
        await fill(
          range.getByRole("spinbutton", { name: "Out", exact: true }),
          "12",
          "range Out",
        );
        const lane = range.getByRole("checkbox", {
          name: "reference",
          exact: true,
        });
        if (!(await lane.isChecked()))
          await act("check", "reference range lane", () => lane.check());
        await click(
          range.getByRole("button", { name: "Select range", exact: true }),
          "Select range",
        );
      } else {
        await click(
          active.getByRole("button", { name: "Menu", exact: true }),
          "transport Menu",
        );
        await click(
          active.getByRole("menuitem", { name: "Select a range", exact: true }),
          "arm range",
        );
        const box = await active
          .locator('[data-clip-id="second-copy"]')
          .boundingBox();
        if (!box) throw new Error("Range body has no geometry");
        await act("drag", "range 11 through 12", async () => {
          await active.mouse.move(box.x + scale, box.y + box.height / 2);
          await active.mouse.down();
          await active.mouse.move(box.x + 2 * scale, box.y + box.height / 2, {
            steps: 10,
          });
          if (cancel) await active.keyboard.press("Escape");
          await active.mouse.up();
        });
      }
      const range = active.getByRole("region", { name: "Range actions" });
      if (cancel) {
        if (routeId === "range-form")
          await click(
            range.getByRole("button", { name: "Clear range", exact: true }),
            "Clear range",
          );
      } else
        await click(
          range.getByRole("button", { name: "Cut", exact: true }),
          "Cut selected range",
        );
      return;
    }
    if (task.id === "trim" || task.id === "fade") {
      const fade = task.id === "fade";
      await click(first.locator(".clip-hit"), "select first-copy");
      const handle = first.locator(
        fade ? ".fade-corner.in" : ".trim-handle.in",
      );
      if (routeId === "handle-pointer" || routeId === "corner-pointer") {
        if (cancel) {
          for (
            let index = 0;
            index < 40 &&
            !(await handle.evaluate(
              (element) => document.activeElement === element,
            ));
            index++
          )
            await key(active, "Tab");
          await expect(handle).toBeFocused();
          await expect(handle).toBeVisible();
          await captureUi(active, "cancel-handle-tab-focus");
        }
        await drag(active, handle, scale * (fade ? 0.04 : 0.3), 0, cancel);
      } else if (routeId === "handle-keyboard") {
        await focus(handle, "trim In handle");
        await act("key-burst", "30 ArrowRight trim nudges", async () => {
          for (let index = 0; index < 30; index++)
            await active.keyboard.down("ArrowRight");
          if (cancel) await active.keyboard.press("Escape");
          await active.keyboard.up("ArrowRight");
        });
      } else {
        const slider = active.getByRole("slider", {
          name: "Fade in ms",
          exact: true,
        });
        await focus(slider, "Fade in ms");
        await act("key-burst", "40ms native fade preview", async () => {
          for (let index = 0; index < 40; index++)
            await active.keyboard.down("ArrowRight");
          if (cancel) await active.keyboard.press("Escape");
          await active.keyboard.up("ArrowRight");
          if (!cancel) await slider.blur();
        });
      }
      return;
    }
    if (task.id === "envelope") {
      if (routeId === "point-pointer") {
        const point = active.locator(
          'circle[aria-label^="Envelope point 1 at"]',
        );
        const svg = await point.locator("xpath=..").boundingBox();
        if (!svg) throw new Error("Envelope has no geometry");
        await drag(
          active,
          point,
          scale * 4,
          (-0.2 / 1.5) * (svg.height - 8),
          cancel,
        );
      } else {
        await openTrack(active, "reference");
        await click(
          active.getByRole("button", {
            name: "Edit volume envelope",
            exact: true,
          }),
          "Edit volume envelope",
        );
        await act("select", "Envelope point p1", () =>
          active
            .getByRole("combobox", { name: "Envelope point", exact: true })
            .selectOption("p1"),
        );
        await click(
          active.getByRole("button", { name: "Edit point", exact: true }),
          "Edit point",
        );
        await fill(
          active.getByRole("textbox", {
            name: "Time (seconds on timeline)",
            exact: true,
          }),
          "6",
          "point time",
        );
        await fill(
          active.getByRole("textbox", { name: "Level (×)", exact: true }),
          "0.8",
          "point level",
        );
        await click(
          active.getByRole("button", {
            name: cancel ? "Cancel" : "Save point",
            exact: true,
          }),
          cancel ? "Cancel point" : "Save point",
        );
      }
      return;
    }
    if (task.id === "reorder") {
      if (routeId === "move-up" || routeId === "move-up-tab-header") {
        await openTrack(active, "guest");
        await click(
          active.getByRole("button", { name: "Move track up", exact: true }),
          "Move track up",
        );
      } else {
        const source = active.getByRole("button", {
          name: "Reorder track guest",
          exact: true,
        });
        const target = active
          .getByRole("button", {
            name: "Open track details, reference",
            exact: true,
          })
          .locator("xpath=..");
        if (cancel) {
          const box = await source.boundingBox();
          if (!box) throw new Error("Reorder handle unavailable");
          await act("drag", "cancel HTML drag", async () => {
            await active.mouse.move(
              box.x + box.width / 2,
              box.y + box.height / 2,
            );
            await active.mouse.down();
            await active.mouse.move(box.x + 5, box.y - 25, { steps: 8 });
            await active.keyboard.press("Escape");
            await active.mouse.up();
          });
        } else
          await act("drag", "guest before reference HTML drag", () =>
            source.dragTo(target, { targetPosition: { x: 10, y: 2 } }),
          );
      }
      return;
    }
    if (task.id === "mix" || task.id === "comment") {
      await click(
        active
          .getByRole("navigation", { name: "Primary" })
          .getByRole("button", { name: "More", exact: true }),
        "Primary More",
      );
      await click(
        active.getByRole("button", {
          name: task.id === "mix" ? "Mix" : "Comments",
          exact: true,
        }),
        task.id === "mix" ? "Mix" : "Comments",
      );
    }
    if (task.id === "mix") {
      const slider = active.getByRole("slider", {
        name: "Volume reference",
        exact: true,
      });
      if (routeId === "native-keyboard") {
        await focus(slider, "Volume reference");
        for (let index = 0; index < 12; index++) {
          await key(active, "ArrowLeft");
          await expect
            .poll(
              () =>
                trial.journal.filter(
                  (row) => row.kind === "response" && row.phase === "action",
                ).length,
            )
            .toBe(index + 1);
        }
      } else {
        const box = await slider.boundingBox();
        if (!box) throw new Error("Mix slider unavailable");
        const min = Number(await slider.getAttribute("min")),
          max = Number(await slider.getAttribute("max"));
        const x = box.x + 8 + ((box.width - 16) * (-6 - min)) / (max - min),
          y = box.y + box.height / 2;
        if (cancel) {
          await act(
            "touch-cancel",
            "native Mix trusted touchCancel",
            async () => {
              await session.send("Input.dispatchTouchEvent", {
                type: "touchStart",
                touchPoints: [
                  { x: box.x + (box.width * (0 - min)) / (max - min), y },
                ],
              });
              await session.send("Input.dispatchTouchEvent", {
                type: "touchMove",
                touchPoints: [{ x, y }],
              });
              await captureUi(active, "intermediate-mix", false);
              await session.send("Input.dispatchTouchEvent", {
                type: "touchCancel",
                touchPoints: [],
              });
              await expect(slider).toHaveValue("0");
            },
          );
          return;
        }
        await act("drag", "Volume reference to -6dB", async () => {
          await active.mouse.move(
            box.x + (box.width * (0 - min)) / (max - min),
            y,
          );
          await active.mouse.down();
          await active.mouse.move(x, y, { steps: 10 });
          await active.mouse.up();
        });
      }
      return;
    }
    if (task.id === "comment") {
      const card = active
        .locator(".comment-card")
        .filter({ hasText: "Editing task comment" });
      if (routeId === "resolve-button")
        await click(
          card.getByRole("button", { name: "Resolve", exact: true }),
          "Resolve comment",
        );
      else {
        const box = await card.locator(".comment-card-main").boundingBox();
        if (!box) throw new Error("Comment unavailable");
        const x = box.x + box.width * 0.7,
          y = box.y + box.height / 2;
        await act(
          "touch-swipe",
          cancel
            ? `${cancelProbe} comment cancellation`
            : "trusted64px comment swipe",
          async () => {
            await session.send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [{ x, y }],
            });
            await session.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [
                {
                  x: x - (cancel ? (cancelProbe === "short" ? 20 : 64) : 64),
                  y: y + (cancel && cancelProbe === "vertical" ? 30 : 0),
                },
              ],
            });
            await captureUi(active, "intermediate-swipe", false);
            await session.send("Input.dispatchTouchEvent", {
              type:
                cancel && cancelProbe === "touch-cancel"
                  ? "touchCancel"
                  : "touchEnd",
              touchPoints: [],
            });
          },
        );
      }
    }
  };
  let fixture: ReturnType<typeof createEditingFixture>;
  try {
    fixture = createEditingFixture(task, output);
  } catch (error) {
    trial.errors!.push(`fixture: ${String(error)}`);
    retain();
    throw error;
  }
  trial.fixture = {
    projectPath: fixture.projectPath,
    savedHash: createHash("sha256")
      .update(JSON.stringify(readEditingState(fixture.projectPath)))
      .digest("hex"),
    media: Object.fromEntries(
      ["reference", "guest"].map((id) => [
        id,
        createHash("sha256")
          .update(
            fs.readFileSync(
              path.join(fixture.workspaceDir, "raw", `${id}.wav`),
            ),
          )
          .digest("hex"),
      ]),
    ),
  };
  const history = () => {
    const project = object(
      JSON.parse(fs.readFileSync(fixture.projectPath, "utf8")),
    );
    const saved = object(project.history);
    const cursor = Number(saved.cursor);
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
      !Number.isSafeInteger(cursor) ||
      cursor < -1 ||
      cursor >= entries.length
    )
      throw new Error("Malformed saved history cursor");
    return { cursor, headId: cursor >= 0 ? entries[cursor].id : null, entries };
  };
  trial.history = { before: history(), after: null, undone: null };
  fs.copyFileSync(
    fixture.projectPath,
    path.join(output, "initial-project.json"),
  );
  const profiler = await createEditorProfiler(
    page,
    cdp,
    info,
    fixture.projectPath,
    0,
    true,
  );
  observe(page);
  try {
    if (chosen.cancel) {
      const canceledFixture = createEditingFixture(task, output);
      let activeCancelFixture = canceledFixture;
      const context = await page
        .context()
        .browser()!
        .newContext({
          viewport: task.viewport,
          hasTouch: chosen.input === "cdp-touch" || task.id === "mix",
        });
      const cancelPage = await context.newPage();
      const cancelCdp = await context.newCDPSession(cancelPage);
      observe(cancelPage);
      try {
        const probes =
          task.id === "comment"
            ? ["short", "vertical", "touch-cancel"]
            : ["cancel"];
        for (const [index, probe] of probes.entries()) {
          const clone =
            index === 0 ? canceledFixture : createEditingFixture(task, output);
          activeCancelFixture = clone;
          fs.copyFileSync(
            clone.projectPath,
            path.join(output, `canceled-${probe}-initial-project.json`),
          );
          await prepare(cancelPage, clone.projectPath);
          phase = "cancel";
          await captureUi(cancelPage, `cancel-${probe}-initiation`);
          await perform(cancelPage, cancelCdp, true, probe);
          await flush(cancelPage);
          await captureUi(cancelPage, `cancel-${probe}-recovery`);
          trial.canceled = readEditingState(clone.projectPath);
          (trial.cancellations ??= []).push({ probe, state: trial.canceled });
          fs.copyFileSync(
            clone.projectPath,
            path.join(output, `canceled-${probe}-project.json`),
          );
          retain();
        }
      } catch (error) {
        trial.errors!.push(`cancel: ${String(error)}`);
        trial.canceled = readEditingState(activeCancelFixture.projectPath);
        fs.copyFileSync(
          activeCancelFixture.projectPath,
          path.join(output, "failed-cancel-project.json"),
        );
        await captureUi(cancelPage, "failed-cancel-recovery");
        retain();
      } finally {
        await flush(cancelPage).catch((error) =>
          trial.errors!.push(`cancel response drain: ${String(error)}`),
        );
        await context.close();
      }
    }
    await prepare(page, fixture.projectPath);
    if (process.platform === "linux") {
      const port = process.env.DAW_E2E_PORT;
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
        processes[0].cwd !== path.resolve("../..") ||
        processes[0].productionDist !== process.env.PODCAST_GUI_DIST ||
        processes[0].shareRegistry !== process.env.PODCAST_SHARE_REGISTRY
      )
        throw new Error(
          "Live backend process provenance differs from admitted source/build/isolation",
        );
    }
    await page.screenshot({
      path: path.join(output, "before.png"),
      fullPage: true,
    });
    trial.artifacts!.push("before.png");
    trial.before = readEditingState(fixture.projectPath);
    retain();
    phase = "action";
    await captureUi(page, "initiation");
    const measureAction = () =>
      profiler.measure(
        {
          id: `editing-${task.id}-${routeId}`,
          phase: "warm",
          input: `${chosen.input} current-main editing task`,
        },
        async () => {
          await perform(page, cdp, false);
          await captureUi(page, "input-complete");
          await expect
            .poll(() =>
              savedStateDifferences(
                task.expected,
                readEditingState(fixture.projectPath, task.id === "range-cut"),
                "after",
                chosen.input === "pointer" || chosen.input === "cdp-touch"
                  ? task.tolerances
                  : Object.fromEntries(
                      Object.keys(task.tolerances).map((key) => [key, 1e-6]),
                    ),
              ),
            )
            .toEqual([]);
          trial.after = readEditingState(
            fixture.projectPath,
            task.id === "range-cut",
          );
          if (task.seek !== undefined)
            trial.transport = {
              seconds: Number(
                await page
                  .getByRole("slider", { name: "Timeline position" })
                  .getAttribute("aria-valuenow"),
              ),
              playing: await page
                .getByRole("button", { name: "Pause", exact: true })
                .isVisible(),
            };
          retain();
          return {
            kind: "existing",
            contract: path.join(output, "trial.json"),
          };
        },
      );
    if (mode === "diagnostic")
      await profiler.trace(async () => {
        await measureAction();
      });
    else await measureAction();
    trial.durationMs = profiler.report.samples[0]?.driverWallMs;
    await flush(page);
    trial.history!.after = history();
    fs.copyFileSync(
      fixture.projectPath,
      path.join(output, "committed-project.json"),
    );
    await page.screenshot({
      path: path.join(output, "saved.png"),
      fullPage: true,
    });
    trial.artifacts!.push("saved.png");
    await captureUi(page, "saved");
    phase = "undo";
    if (chosen.undo === "comment-toast")
      await click(
        page
          .locator(".comments-panel .ui-toast")
          .getByRole("button", { name: "Undo", exact: true }),
        "comment toast Undo",
      );
    if (chosen.undo === "history") {
      if (task.viewport.width < 720)
        await click(
          page
            .getByRole("dialog", { name: "Mix", exact: true })
            .getByRole("button", { name: "Close", exact: true }),
          "Close Mix",
        );
      await focus(
        page.getByRole("button", { name: "Menu", exact: true }),
        "non-typing Menu",
      );
      for (let index = 0; index < chosen.mutations; index++) {
        await key(page, "ControlOrMeta+z");
        await expect
          .poll(
            () =>
              trial.journal.filter(
                (row) => row.kind === "response" && row.phase === "undo",
              ).length,
          )
          .toBe(index + 1);
      }
    }
    if (chosen.undo !== "none") {
      await expect
        .poll(() => readEditingState(fixture.projectPath))
        .toEqual(task.start);
      await flush(page);
      trial.undone = readEditingState(fixture.projectPath);
      trial.history!.undone = history();
      fs.copyFileSync(
        fixture.projectPath,
        path.join(output, "undone-project.json"),
      );
      await page.screenshot({
        path: path.join(output, "undone.png"),
        fullPage: true,
      });
      trial.artifacts!.push("undone.png");
      await captureUi(page, "undo-recovery");
    }
  } catch (error) {
    trial.errors!.push(String(error));
    await page
      .screenshot({ path: path.join(output, "failed.png"), fullPage: true })
      .catch(() => {});
    trial.artifacts!.push("failed.png");
    try {
      trial.after ??= readEditingState(
        fixture.projectPath,
        task.id === "range-cut",
      );
    } catch (error) {
      trial.errors!.push(`saved state: ${String(error)}`);
    }
  } finally {
    await flush(page).catch((error) =>
      trial.errors!.push(`main response drain: ${String(error)}`),
    );
    await profiler.finish();
    trial.profiler = process.env.DAW_PROFILE_OUT
      ? path.join(process.env.DAW_PROFILE_OUT, "report.json")
      : info.outputPath("editor-profile", "report.json");
    const identities: Record<string, string> = {};
    try {
      readEditingState(
        fixture.projectPath,
        task.id === "range-cut",
        identities,
      );
    } catch (error) {
      trial.errors!.push(`identity map: ${String(error)}`);
    }
    fs.writeFileSync(
      path.join(output, "clip-identities.json"),
      JSON.stringify(identities, null, 2),
    );
    fs.copyFileSync(
      fixture.projectPath,
      path.join(output, "saved-project.json"),
    );
    retain();
    fs.writeFileSync(
      path.join(output, "assessment.json"),
      JSON.stringify(assessEditingTrial(task, trial), null, 2),
    );
  }
  return trial;
}
