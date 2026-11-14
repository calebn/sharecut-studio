import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { minimalProject } from "../test/fixtures";
import { documentAuthority, resetDocumentAuthority } from "./authorityState";
import { scheduleTranscriptDetailHydrate } from "./hydrateTranscriptDetail";
import type { DocumentSnapshot } from "./projectPatch";
import { settledTranscriptOf, transcriptGrantOf } from "./shownTranscript";
import { TRANSCRIPT_STALL_MS } from "./transcriptStall";
import { useTranscriptDetail } from "./useTranscriptDetail";

const { loadDetail } = vi.hoisted(() => ({ loadDetail: vi.fn() }));
vi.mock("../api/project", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/project")>()),
  loadDocumentState: loadDetail,
}));

afterEach(() => {
  resetDocumentAuthority();
});

it("only lets the current Retry restart a failure after an untracked view", async () => {
  const project = minimalProject({
    meta: {
      name: "Test Episode",
      workspace_dir: "/tmp/test",
      hydration: { transcript_words: false },
    },
  });
  useDawStore
    .getState()
    .hydrate(
      "share:tok",
      project,
      "comment",
      ["view", "comment", "suggest"],
      null,
      true,
    );
  resetDocumentAuthority("share:tok");
  const request = deferred<DocumentSnapshot>();
  const replacement = deferred<DocumentSnapshot>();
  loadDetail
    .mockReturnValueOnce(request.promise)
    .mockReturnValueOnce(replacement.promise);
  const { result } = renderHook(useTranscriptDetail);
  const untracked = result.current;
  expect(untracked.kind).toBe("pending");
  if (untracked.kind !== "pending") throw new Error("Expected untracked Retry");
  expect(loadDetail).toHaveBeenCalledTimes(0);

  act(() => scheduleTranscriptDetailHydrate(project));
  await act(async () => request.reject(new Error("private transport detail")));
  const failed = result.current;
  expect(failed).toMatchObject({ kind: "failed", recovering: false });
  if (failed.kind !== "failed") throw new Error("Expected failed Retry");

  act(() => untracked.retry());
  expect(loadDetail).toHaveBeenCalledTimes(1);
  expect(result.current).toMatchObject({ kind: "failed", recovering: false });

  act(() => failed.retry());
  expect(loadDetail).toHaveBeenCalledTimes(2);
  expect(result.current).toMatchObject({ kind: "failed", recovering: true });
});

function viewerShell() {
  return minimalProject({
    meta: {
      name: "Test Episode",
      workspace_dir: "/tmp/test",
      hydration: { transcript_words: false },
    },
  });
}

it("a Viewer with a granted flag and an incomplete shell loads detail once and becomes ready", async () => {
  const project = viewerShell();
  useDawStore
    .getState()
    .hydrate("share:tok", project, "view", ["play", "view"], null, true);
  resetDocumentAuthority("share:tok");
  documentAuthority.project = project;
  documentAuthority.token = "a".repeat(64);
  documentAuthority.phase = { kind: "ready" };
  const request = deferred<DocumentSnapshot>();
  loadDetail.mockReturnValueOnce(request.promise);
  const { result } = renderHook(useTranscriptDetail);
  expect(result.current.kind).toBe("pending");

  act(() => scheduleTranscriptDetailHydrate(project));
  expect(loadDetail).toHaveBeenCalledTimes(1);
  expect(loadDetail.mock.calls[0]?.[1]).toBe("detail");
  expect(result.current.kind).toBe("pending");

  await act(async () =>
    request.resolve({
      server_seq: 0,
      state_token: "a".repeat(64),
      project: minimalProject({
        meta: {
          name: "Test Episode",
          workspace_dir: "/tmp/test",
          hydration: { transcript_words: true },
        },
      }),
    }),
  );
  expect(result.current.kind).toBe("ready");
});

it("a detail with a drifted token waits for its shell recovery instead of failing", async () => {
  const project = viewerShell();
  useDawStore
    .getState()
    .hydrate("share:tok", project, "view", ["play", "view"], null, true);
  resetDocumentAuthority("share:tok");
  documentAuthority.project = project;
  documentAuthority.token = "a".repeat(64);
  documentAuthority.phase = { kind: "ready" };
  const detail = deferred<DocumentSnapshot>();
  const shell = deferred<DocumentSnapshot>();
  loadDetail
    .mockReturnValueOnce(detail.promise)
    .mockReturnValueOnce(shell.promise);
  const { result } = renderHook(useTranscriptDetail);
  act(() => scheduleTranscriptDetailHydrate(project));

  await act(async () =>
    detail.resolve({
      server_seq: 0,
      state_token: "b".repeat(64),
      project: minimalProject({
        meta: {
          name: "Test Episode",
          workspace_dir: "/tmp/test",
          hydration: { transcript_words: true },
        },
      }),
    }),
  );
  // The recovery's shell fetch is the second call; no failure cover meanwhile.
  expect(loadDetail.mock.calls[1]?.[1]).toBe("shell");
  expect(result.current.kind).toBe("pending");
});

it("a flag of false is hidden and never loads detail", () => {
  const project = viewerShell();
  useDawStore
    .getState()
    .hydrate("share:tok", project, "view", ["play", "view"], null, false);
  resetDocumentAuthority("share:tok");
  loadDetail.mockClear();
  const { result } = renderHook(useTranscriptDetail);
  expect(result.current.kind).toBe("hidden");
  act(() => scheduleTranscriptDetailHydrate(project));
  expect(loadDetail).not.toHaveBeenCalled();
});

function guestRow(text: string, at: number, withWords: boolean) {
  const word = {
    text,
    start: at,
    end: at + 1,
    word_index: at,
    timeline_start: at,
    timeline_end: at + 1,
  };
  return {
    track_id: "a",
    source_id: "s",
    speaker: "Ann",
    start: at,
    end: at + 1,
    text,
    mappable: true,
    timeline_start: at,
    timeline_end: at + 1,
    ...(withWords ? { words: [word] } : {}),
  };
}
function guestProject(rows: ReturnType<typeof guestRow>[], complete: boolean) {
  return minimalProject({
    transcript: { utterances: rows } as never,
    meta: {
      name: "Test Episode",
      workspace_dir: "/tmp/test",
      hydration: { transcript_words: complete },
    },
  });
}
function openGuest() {
  const complete = guestProject(
    [guestRow("one", 0, true), guestRow("two", 4, true)],
    true,
  );
  useDawStore
    .getState()
    .hydrate("share:tok", complete, "view", ["play", "view"], null, true);
  resetDocumentAuthority("share:tok");
  documentAuthority.token = "a".repeat(64);
  documentAuthority.phase = { kind: "ready" };
  documentAuthority.project = complete;
  documentAuthority.settled = settledTranscriptOf(
    complete,
    transcriptGrantOf(useDawStore.getState()),
  );
}
const showWordFree = (rows: ReturnType<typeof guestRow>[]) =>
  act(() => {
    const project = guestProject(rows, false);
    documentAuthority.project = project;
    useDawStore.setState({ project });
  });
const hold = () => {
  loadDetail.mockReturnValue(new Promise(() => undefined));
};

it("a guest with remembered words stays ready and refreshing through word-free commits", () => {
  openGuest();
  hold();
  const seen: string[] = [];
  const { result } = renderHook(() => {
    const view = useTranscriptDetail();
    seen.push(view.kind);
    return view;
  });
  expect(result.current.kind).toBe("ready");
  showWordFree([
    guestRow("one", 0, false),
    { ...guestRow("two", 4, false), timeline_start: 7 },
  ]);
  const first = result.current;
  if (first.kind !== "ready") throw new Error("expected ready");
  expect(first.shown.refreshing).toBe(true);
  expect(first.shown.rows.map((r) => r.kind)).toEqual(["held", "held"]);
  showWordFree([guestRow("one", 0, false)]);
  act(() => scheduleTranscriptDetailHydrate(useDawStore.getState().project));
  expect(result.current.kind).toBe("ready");
  expect(new Set(seen)).toEqual(new Set(["ready"]));
});

it("a guest with nothing remembered is pending as on first load", () => {
  const first = guestProject([guestRow("one", 0, false)], false);
  useDawStore
    .getState()
    .hydrate("share:tok", first, "view", ["play", "view"], null, true);
  resetDocumentAuthority("share:tok");
  documentAuthority.project = first;
  documentAuthority.phase = { kind: "ready" };
  const { result } = renderHook(useTranscriptDetail);
  expect(result.current.kind).toBe("pending");
});

it("a failed refresh replaces held words with the failure", async () => {
  openGuest();
  const request = deferred<DocumentSnapshot>();
  loadDetail.mockReturnValueOnce(request.promise);
  const { result } = renderHook(useTranscriptDetail);
  showWordFree([
    guestRow("one", 0, false),
    { ...guestRow("two", 4, false), timeline_start: 7 },
  ]);
  act(() => scheduleTranscriptDetailHydrate(useDawStore.getState().project));
  expect(result.current.kind).toBe("ready");
  await act(async () => request.reject(new Error("offline")));
  expect(result.current).toMatchObject({ kind: "failed", recovering: false });
});

it("remembered words do not outlive a change of link or of grant", () => {
  openGuest();
  hold();
  const { result } = renderHook(useTranscriptDetail);
  showWordFree([guestRow("one", 0, false)]);
  expect(result.current.kind).toBe("ready");
  act(() => useDawStore.setState({ shareCapabilities: ["play"] }));
  expect(result.current.kind).toBe("pending");
  act(() => {
    resetDocumentAuthority("share:other");
    useDawStore.setState({ projectPath: "share:other" });
  });
  expect(result.current.kind).toBe("pending");
});

it("a host session never holds words", () => {
  const complete = guestProject([guestRow("one", 0, true)], true);
  useDawStore.getState().hydrate("/tmp/host.json", complete);
  resetDocumentAuthority("/tmp/host.json");
  documentAuthority.settled = settledTranscriptOf(
    complete,
    transcriptGrantOf(useDawStore.getState()),
  );
  hold();
  const { result } = renderHook(useTranscriptDetail);
  showWordFree([guestRow("one", 0, false)]);
  expect(result.current.kind).toBe("pending");
});

it("a guest with all rows waiting but a remembered grant is ready, drawn as bars", () => {
  openGuest();
  hold();
  const { result } = renderHook(useTranscriptDetail);
  showWordFree([
    { ...guestRow("uno", 0, false), text: "uno" },
    { ...guestRow("dos", 4, false), text: "dos" },
  ]);
  if (result.current.kind !== "ready") throw new Error("expected ready");
  expect(result.current.shown.rows.map((r) => r.kind)).toEqual([
    "waiting",
    "waiting",
  ]);
});

describe("a refresh that stops moving", () => {
  const STALL = TRANSCRIPT_STALL_MS;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const wordFree = () => [
    guestRow("one", 0, false),
    { ...guestRow("two", 4, false), timeline_start: 7 },
  ];

  it("becomes failed after 35 s on the same commit", () => {
    openGuest();
    hold();
    const { result } = renderHook(useTranscriptDetail);
    showWordFree(wordFree());
    expect(result.current.kind).toBe("ready");
    act(() => vi.advanceTimersByTime(STALL - 1));
    expect(result.current.kind).toBe("ready");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toMatchObject({ kind: "failed", recovering: false });
  });

  it("restarts the clock on a new commit", () => {
    openGuest();
    hold();
    const { result } = renderHook(useTranscriptDetail);
    showWordFree(wordFree());
    act(() => vi.advanceTimersByTime(20_000));
    act(() => {
      documentAuthority.token = "b".repeat(64);
      useDawStore.setState({ project: guestProject(wordFree(), false) });
    });
    act(() => vi.advanceTimersByTime(20_000));
    expect(result.current.kind).toBe("ready");
    act(() => vi.advanceTimersByTime(STALL - 20_000));
    expect(result.current.kind).toBe("failed");
  });

  it("Retry from the stuck state schedules the detail again and restarts the clock", () => {
    openGuest();
    hold();
    const { result } = renderHook(useTranscriptDetail);
    showWordFree(wordFree());
    act(() => scheduleTranscriptDetailHydrate(useDawStore.getState().project));
    act(() => vi.advanceTimersByTime(STALL));
    if (result.current.kind !== "failed") throw new Error("expected failed");
    loadDetail.mockClear();
    act(() => (result.current as { retry: () => void }).retry());
    expect(loadDetail).toHaveBeenCalledTimes(1);
    expect(result.current.kind).toBe("ready");
    act(() => vi.advanceTimersByTime(STALL));
    expect(result.current.kind).toBe("failed");
  });

  it("Retry starts a stalled recovery again", () => {
    openGuest();
    hold();
    const { result } = renderHook(useTranscriptDetail);
    showWordFree(wordFree());
    documentAuthority.phase = { kind: "recovering", minimum: 1 };
    act(() => vi.advanceTimersByTime(STALL));
    loadDetail.mockClear();
    act(() => (result.current as { retry: () => void }).retry());
    expect(loadDetail).toHaveBeenCalledWith(
      "share:tok",
      "shell",
      expect.anything(),
    );
  });

  it("answers every caller alike, before and after Retry, on one clock", () => {
    openGuest();
    hold();
    const a = renderHook(useTranscriptDetail);
    const b = renderHook(useTranscriptDetail);
    showWordFree(wordFree());
    const timers = vi.getTimerCount();
    act(() => vi.advanceTimersByTime(STALL));
    expect(a.result.current.kind).toBe("failed");
    expect(b.result.current.kind).toBe("failed");
    act(() => (a.result.current as { retry: () => void }).retry());
    expect(a.result.current.kind).toBe("ready");
    expect(b.result.current.kind).toBe("ready");
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timers);
    act(() => vi.advanceTimersByTime(STALL));
    expect(b.result.current.kind).toBe("failed");
  });

  it("does not carry a stall into the next document", () => {
    openGuest();
    hold();
    const { result } = renderHook(useTranscriptDetail);
    showWordFree(wordFree());
    act(() => vi.advanceTimersByTime(STALL));
    expect(result.current.kind).toBe("failed");
    act(() => {
      resetDocumentAuthority("share:tok");
    });
    expect(result.current.kind).not.toBe("failed");
  });

  it("never fails a host", () => {
    const complete = guestProject([guestRow("one", 0, true)], true);
    useDawStore.getState().hydrate("/tmp/host.json", complete);
    resetDocumentAuthority("/tmp/host.json");
    hold();
    const { result } = renderHook(useTranscriptDetail);
    showWordFree([guestRow("one", 0, false)]);
    act(() => vi.advanceTimersByTime(STALL * 2));
    expect(result.current.kind).toBe("pending");
  });
});
