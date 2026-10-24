import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { minimalProject, sampleTrack } from "../test/fixtures";
import type { ClipRow, ProjectView } from "../types/project";
import { documentAuthority, resetDocumentAuthority } from "./authorityState";
import { editBasisKey } from "./editBasisKey";

const clip = (id: string, timeline_start: number): ClipRow => ({
  id,
  track_id: "host",
  timeline_start,
  timeline_end: timeline_start + 2,
  source_start: 0,
  source_end: 2,
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
  source_id: null,
  source_duration_sec: null,
  recording_key: null,
});
const base = (): ProjectView =>
  minimalProject({
    tracks: [sampleTrack({ id: "host" })],
    clips: { clip_count: 1, tracks: { host: [clip("a", 5)] } },
    transcript: { utterances: [] },
  });

beforeEach(() => {
  resetDocumentAuthority("/tmp/p");
  documentAuthority.seq = 4;
  documentAuthority.token = "tok";
});
afterEach(() => resetDocumentAuthority());

describe("editBasisKey", () => {
  it("is empty for no project", () => {
    expect(editBasisKey(null)).toBe("");
  });
  const hydrate = (p: ProjectView): ProjectView => ({
    ...p,
    transcript: { utterances: [{ id: "u" } as never] },
    meta: { ...p.meta, hydration: { transcript_words: true } },
    history: { ...p.history, groups: [{ id: "g" } as never] },
  });
  it("is stable when only the transcript, meta.hydration and history.groups change", () => {
    const project = base();
    const key = editBasisKey(project);
    const hydrated = hydrate(project);
    expect(hydrated).not.toBe(project);
    expect(editBasisKey(hydrated)).toBe(key);
  });
  it("keeps the late-load exclusions on the uncached path", () => {
    const project = base();
    const hydrated = hydrate(project);
    const key = editBasisKey(project);
    editBasisKey(minimalProject({ meta: { name: "other" } as never }));
    expect(editBasisKey(hydrated)).toBe(key);
    editBasisKey(minimalProject({ meta: { name: "other" } as never }));
    expect(editBasisKey(project)).toBe(key);
  });
  it("is stable for a content-identical copy of the root", () => {
    const project = base();
    expect(editBasisKey({ ...project })).toBe(editBasisKey(project));
  });
  it.each([
    [
      "document seq",
      () => {
        documentAuthority.seq = 5;
      },
    ],
    [
      "document token",
      () => {
        documentAuthority.token = "other";
      },
    ],
  ])("changes with the %s", (_name, change) => {
    const project = base();
    const key = editBasisKey(project);
    change();
    expect(editBasisKey(project)).not.toBe(key);
  });
  it.each<[string, (p: ProjectView) => ProjectView]>([
    [
      "history head",
      (p) => ({ ...p, history: { ...p.history, head_id: "h2" as never } }),
    ],
    [
      "a clip row",
      (p) => ({
        ...p,
        clips: { ...p.clips, tracks: { host: [clip("a", 6)] } },
      }),
    ],
    [
      "a track row",
      (p) => ({ ...p, tracks: [sampleTrack({ id: "host", muted: true })] }),
    ],
    ["the timeline duration", (p) => ({ ...p, timeline_duration_sec: 100 })],
    [
      "the clips duration",
      (p) => ({ ...p, clips: { ...p.clips, timeline_duration_sec: 100 } }),
    ],
    [
      "the workspace",
      (p) => ({ ...p, meta: { ...p.meta, workspace_dir: "/elsewhere" } }),
    ],
    [
      "another meta field",
      (p) => ({ ...p, meta: { ...p.meta, extra_field: 1 } as never }),
    ],
    [
      "the history cursor",
      (p) => ({ ...p, history: { ...p.history, cursor: 9 } }),
    ],
    [
      "the project name",
      (p) => ({ ...p, meta: { ...p.meta, name: "Renamed" } }),
    ],
  ])("changes with %s", (_name, change) => {
    const project = base();
    const key = editBasisKey(project);
    expect(editBasisKey(change(project))).not.toBe(key);
  });
  it("returns the same string for the same references and recomputes after a change", () => {
    const project = base();
    const key = editBasisKey(project);
    expect(editBasisKey(project)).toBe(key);
    expect(editBasisKey({ ...project })).toBe(key);
    const moved = { ...project, timeline_duration_sec: 100 };
    expect(editBasisKey(moved)).not.toBe(key);
    expect(editBasisKey(project)).toBe(key);
  });
});
