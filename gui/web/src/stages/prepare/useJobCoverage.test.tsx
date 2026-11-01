import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { mediaKeyOf, recordJobMedia } from "../../state/jobMedia";
import { seedStudioJob } from "../../state/seedStudioJob";
import {
  minimalProject,
  pipelineJobSnapshot,
  sampleTrack,
} from "../../test/fixtures";
import { preparePhase, readyRows } from "./prepareMappers";
import { useJobCoverage } from "./useJobCoverage";

type Props = { id: string | null; key: string };

function setup(initial: Props) {
  return renderHook(({ id, key }: Props) => useJobCoverage(id, key), {
    initialProps: initial,
  });
}

const A = "a:/tmp/a.wav";
const AB = "a:/tmp/a.wav|b:/tmp/b.wav";

function finished(id: string) {
  return pipelineJobSnapshot({
    id,
    status: "ok",
    steps: [
      { name: "transcribe_tracks", status: "ok", elapsed_sec: 1, error: null },
      {
        name: "analyze_fillers_pauses",
        status: "ok",
        elapsed_sec: 1,
        error: null,
      },
    ],
  });
}

function screen(covers: boolean, transcribed: boolean) {
  const rows = readyRows({
    sourceCount: 2,
    ingestBusy: false,
    transcribed,
    jobCoversMedia: covers,
    starting: false,
    job: finished("j1"),
    pendingSuggestions: 0,
    model: null,
    approximateTiming: null,
    keepFixes: null,
  });
  const { phase } = preparePhase({
    sources: 2,
    ingestBusy: false,
    checking: false,
    rows,
  });
  return { rows, phase };
}

beforeEach(() => {
  useDawStore.setState({
    project: minimalProject({
      tracks: [sampleTrack({ id: "a" }), sampleTrack({ id: "b" })],
    }),
    pipelineJob: null,
    activityJob: null,
  });
});

describe("useJobCoverage", () => {
  it("covers the audio a job was started on", () => {
    recordJobMedia("c1", A);
    const { result } = setup({ id: "c1", key: A });
    expect(result.current).toBe(true);
  });

  it("stops covering once different audio arrives", () => {
    recordJobMedia("c2", A);
    const { result, rerender } = setup({ id: "c2", key: A });
    rerender({ id: "c2", key: AB });
    expect(result.current).toBe(false);
  });

  it("covers the new audio for a job started after it", () => {
    recordJobMedia("c3", A);
    recordJobMedia("c4", AB);
    const { result, rerender } = setup({ id: "c3", key: AB });
    expect(result.current).toBe(false);
    rerender({ id: "c4", key: AB });
    expect(result.current).toBe(true);
  });

  it("covers nothing without a job", () => {
    const { result } = setup({ id: null, key: A });
    expect(result.current).toBe(false);
  });

  it("does not cover a job nobody here started (reload, second tab)", () => {
    const { result } = setup({ id: "never-started-here", key: AB });
    expect(result.current).toBe(false);
  });

  it("keeps covering after Prepare unmounts and mounts again", () => {
    recordJobMedia("c5", A);
    setup({ id: "c5", key: A }).unmount();
    const { result } = setup({ id: "c5", key: A });
    expect(result.current).toBe(true);
    const later = setup({ id: "c5", key: AB });
    expect(later.result.current).toBe(false);
  });

  it("covers the current audio when the project loads after the job", () => {
    recordJobMedia("c6", A);
    const { result, rerender } = setup({ id: "c6", key: "" });
    expect(result.current).toBe(false);
    rerender({ id: "c6", key: A });
    expect(result.current).toBe(true);
  });

  it("records nothing for a job started before any project loaded", () => {
    useDawStore.setState({ project: null });
    seedStudioJob(pipelineJobSnapshot({ id: "c7", status: "running" }));
    const { result } = setup({ id: "c7", key: "" });
    expect(result.current).toBe(false);
  });

  it("records the audio on the tracks when a job is seeded", () => {
    seedStudioJob(pipelineJobSnapshot({ id: "c8", status: "running" }));
    const key = mediaKeyOf(useDawStore.getState().project?.tracks);
    expect(setup({ id: "c8", key }).result.current).toBe(true);
    act(() => {
      useDawStore.setState((s) => ({
        project: s.project && {
          ...s.project,
          tracks: [...s.project.tracks, sampleTrack({ id: "c" })],
        },
      }));
    });
    const grown = mediaKeyOf(useDawStore.getState().project?.tracks);
    expect(setup({ id: "c8", key: grown }).result.current).toBe(false);
  });

  it("records nothing for an analyze-only job, so Find hits covers no audio", () => {
    seedStudioJob(
      pipelineJobSnapshot({
        id: "c9",
        status: "ok",
        only_step: "analyze_fillers_pauses",
      }),
    );
    const key = mediaKeyOf(useDawStore.getState().project?.tracks);
    expect(setup({ id: "c9", key }).result.current).toBe(false);
  });
});

describe("mediaKeyOf", () => {
  it("does not depend on track order", () => {
    const a = sampleTrack({ id: "a" });
    const b = sampleTrack({ id: "b" });
    expect(mediaKeyOf([a, b])).toBe(mediaKeyOf([b, a]));
  });

  it("leaves out tracks that are not dialogue or hold no media", () => {
    const music = sampleTrack({ id: "m", role: "music" });
    const empty = sampleTrack({ id: "e", media_path: null });
    expect(mediaKeyOf([music, empty])).toBe("");
    expect(mediaKeyOf(undefined)).toBe("");
  });
});

describe("a finished job and a source with no transcript", () => {
  it("reads Not started with Start after Prepare was left and audio imported (R1)", () => {
    recordJobMedia("j1", A);
    const { result } = setup({ id: "j1", key: AB });
    const { rows, phase } = screen(result.current, false);
    expect(phase).toBe("not-started");
    expect(rows[1]).toMatchObject({ action: { run: "try-again" } });
  });

  it("reads Not started after a reload that finds an old ok job (R7)", () => {
    const { result } = setup({ id: "j1", key: AB });
    const { rows, phase } = screen(result.current, false);
    expect(phase).toBe("not-started");
    expect(rows[1]).toMatchObject({ action: { label: "Start" } });
  });

  it("still reads Done for an old job when every source has utterances", () => {
    const { result } = setup({ id: "j1", key: AB });
    expect(screen(result.current, true).phase).toBe("done");
  });

  it("reads Not started with Start after an analyze-only job on an untranscribed source (N4)", () => {
    seedStudioJob(
      pipelineJobSnapshot({
        id: "j1",
        status: "ok",
        only_step: "analyze_fillers_pauses",
      }),
    );
    const key = mediaKeyOf(useDawStore.getState().project?.tracks);
    const { result } = setup({ id: "j1", key });
    const { rows, phase } = screen(result.current, false);
    expect(phase).toBe("not-started");
    expect(rows[1]).toMatchObject({ action: { label: "Start" } });
  });

  it("reads Done for a Prepare run seeded on this audio with a silent source", () => {
    seedStudioJob(pipelineJobSnapshot({ id: "j1", status: "ok" }));
    const key = mediaKeyOf(useDawStore.getState().project?.tracks);
    const { result } = setup({ id: "j1", key });
    expect(screen(result.current, false).phase).toBe("done");
  });

  it("reads Done for a job started on this audio with a silent source (R3)", () => {
    recordJobMedia("j1", AB);
    const { result, rerender } = setup({ id: "j1", key: "" });
    rerender({ id: "j1", key: AB });
    expect(screen(result.current, false).phase).toBe("done");
  });
});
