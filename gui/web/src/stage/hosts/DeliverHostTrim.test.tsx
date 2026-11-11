import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wire = vi.hoisted(() => ({
  post: vi.fn(),
  rows: [] as { command_id: string }[],
  conflicts: {} as Record<string, unknown[]>,
  seek: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../api/documentTransport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/documentTransport")>()),
  postHostDocumentCommand: wire.post,
}));
vi.mock("../../services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/offlineQueue/offlineStore")
  >()),
  enqueueHostCommand: async (_path: string, cmd: { command_id: string }) => {
    const hadPredecessor = wire.rows.length > 0;
    wire.rows.push(cmd);
    return { persisted: true, hadPredecessor };
  },
  loadHostCommandQueue: async () => [...wire.rows],
  loadHostAttention: async (path: string) => ({
    pending: wire.rows.length,
    conflicts: [...(wire.conflicts[path] ?? [])],
  }),
  settleHostCommandOutcome: async (
    path: string,
    id: string,
    outcome: unknown,
    remove: boolean,
  ) => {
    if (outcome) (wire.conflicts[path] ??= []).push(outcome);
    if (remove) wire.rows = wire.rows.filter((r) => r.command_id !== id);
  },
  removeHostQueuedCommands: async (_path: string, ids: string[]) => {
    wire.rows = wire.rows.filter((r) => !ids.includes(r.command_id));
  },
}));
vi.mock("../../commands/seek", () => ({ seekTransport: wire.seek }));

import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { commandLocks } from "../../test/commandLocks";
import { fakeExportServer } from "../../test/fakeExportServer";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import type { HistoryEntryId } from "../../types/project";
import { ApiError } from "../../utils/apiError";
import { DeliverStage as HostDeliverStage } from "./DeliverStage";
import { ExportFlowProvider } from "./exportFlow";
import { ShareFlowProvider } from "./shareFlow";

function DeliverStage() {
  return (
    <ExportFlowProvider>
      <ShareFlowProvider>
        <HostDeliverStage />
      </ShareFlowProvider>
    </ExportFlowProvider>
  );
}

// Forced-aligned words on the timeline clock; the Out edges sit at 30.25 and 30.9.
const word = (text: string, start: number, end: number) => ({
  text,
  start,
  end,
  timeline_start: start,
  timeline_end: end,
});
const WORDS = [
  word("one", 9.8, 10.3),
  word("two", 10.5, 11),
  word("three", 29.6, 30.25),
  word("four", 30.4, 30.9),
  { ...word("ghost", 31, 31.4), suppressed: true },
];
const TRANSCRIPT = {
  current: null as ReturnType<typeof minimalProject>["transcript"],
};

let runs = 0;
let PATH = "";

const INTRO = { time: 0, title: "Intro" };
const MIDDLE = { time: 120, title: "Middle" };
const CLIP = {
  id: "s1",
  track_id: "t1",
  start: 10,
  end: 40,
  score: 0.9,
  title_suggestion: "A line",
  approved: false,
  review_required: false,
};

type Held = {
  chapters: { time: number; title: string }[];
  social_clips: (typeof CLIP)[];
};

function projectAt(head: string, held: Partial<Held> = {}) {
  const base = minimalProject();
  return minimalProject({
    transcript: TRANSCRIPT.current,
    tracks: [sampleTrack()],
    timeline_duration_sec: 600,
    chapters: held.chapters ?? [INTRO, MIDDLE],
    social_clips: held.social_clips ?? [CLIP],
    history: { ...base.history, head_id: head as HistoryEntryId },
  });
}

const server = {
  held: { chapters: [INTRO, MIDDLE], social_clips: [CLIP] } as Held,
  seq: 0,
};
const network = { mode: "up" as "up" | "down" | "refusing" };

function serve(type: string, p: Record<string, number | string>) {
  const { held } = server;
  if (type === "AddChapter") {
    held.chapters = [
      ...held.chapters,
      { time: Number(p.time), title: String(p.title) },
    ].sort((a, b) => a.time - b.time);
  } else if (type === "UpdateChapter") {
    held.chapters = held.chapters.map((c) =>
      c.time === p.old_time && c.title === p.old_title
        ? { time: Number(p.time), title: String(p.title) }
        : c,
    );
  } else if (type === "DeleteChapter") {
    held.chapters = held.chapters.filter(
      (c) => !(c.time === p.time && c.title === p.title),
    );
  } else if (type === "UpdateSocialClip") {
    held.social_clips = held.social_clips.map((c) =>
      c.id === p.id ? { ...c, start: Number(p.start), end: Number(p.end) } : c,
    );
  } else if (type === "DeleteSocialClip") {
    held.social_clips = held.social_clips.filter((c) => c.id !== p.id);
  }
}

function answer(body: {
  type: string;
  payload: Record<string, number | string>;
}) {
  if (network.mode === "down") {
    return { ok: false, status: 503, failure: new ApiError("busy", null, 503) };
  }
  if (network.mode === "refusing") {
    return {
      ok: false,
      status: 404,
      failure: new ApiError(
        "chapter not found: 'Middle' at 120.0",
        "not_found",
        404,
      ),
    };
  }
  serve(body.type, body.payload);
  server.seq += 1;
  return {
    ok: true,
    data: {
      history_head_id: `s${server.seq}`,
      snapshot: {
        server_seq: server.seq,
        project: projectAt(`s${server.seq}`, server.held),
      },
    },
  };
}

const sent = () =>
  wire.post.mock.calls.map(([, body]) => [body.type, body.payload]);

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  fakeExportServer();
  runs += 1;
  PATH = `/tmp/deliver-host/${runs}/episode.sharecut`;
  vi.clearAllMocks();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: commandLocks(),
  });
  sessionStorage.clear();
  wire.rows = [];
  wire.conflicts = {};
  network.mode = "up";
  server.held = { chapters: [INTRO, MIDDLE], social_clips: [CLIP] };
  server.seq = 0;
  wire.post.mockImplementation(async (_path: string, body) => answer(body));
  stubViewportShell("desktop");
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.getState().hydrate(PATH, projectAt("h1"));
  useDawStore.setState({ stage: "deliver", guestMode: null, playheadSec: 300 });
});

const trimOpen = async () => {
  render(<DeliverStage />);
  await userEvent.click(
    screen.getByRole("button", { name: "More for A line" }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: "Trim" }));
  // The strip shows 7 s to 43 s across 100 px to 700 px.
  vi.spyOn(
    screen.getByRole("group", { name: "Waveform of A line" }),
    "getBoundingClientRect",
  ).mockReturnValue({
    left: 100,
    width: 600,
    right: 700,
    top: 0,
    bottom: 0,
    height: 0,
    x: 100,
    y: 0,
    toJSON: () => ({}),
  });
};
const dragTo = (name: string, seconds: number) => {
  const handle = screen.getByRole("slider", { name });
  const clientX = 100 + 600 * ((seconds - 7) / 36);
  fireEvent.pointerDown(handle, { clientX: 400, pointerId: 1, buttons: 1 });
  fireEvent.pointerMove(handle, { clientX, pointerId: 1, buttons: 1 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
};

describe("Deliver host word-snapped trims", () => {
  it("snaps the handles to the transcript's word edges", async () => {
    TRANSCRIPT.current = {
      utterances: [
        {
          track_id: "t1",
          speaker: "A",
          start: 9.8,
          end: 31.4,
          text: "one two three four ghost",
          words: WORDS,
        },
      ],
    };
    useDawStore.getState().hydrate(PATH, projectAt("h1"));
    await trimOpen();
    dragTo("Out handle of A line", 30.5);
    dragTo("In handle of A line", 10.4);
    await waitFor(() => expect(wire.post).toHaveBeenCalledTimes(2));
    expect(sent()).toEqual([
      ["UpdateSocialClip", { id: "s1", start: 10, end: 30.25 }],
      ["UpdateSocialClip", { id: "s1", start: 10.5, end: 30.25 }],
    ]);
  });

  it("moves the handles freely when the project has no words", async () => {
    TRANSCRIPT.current = null;
    useDawStore.getState().hydrate(PATH, projectAt("h1"));
    await trimOpen();
    dragTo("Out handle of A line", 30.6);
    await waitFor(() => expect(wire.post).toHaveBeenCalledOnce());
    const end = sent()[0]?.[1].end as number;
    expect(end).toBeCloseTo(30.6, 1);
    expect(end).not.toBe(30.25);
  });

  it("snaps once the transcript arrives after the page is open", async () => {
    TRANSCRIPT.current = null;
    useDawStore.getState().hydrate(PATH, projectAt("h1"));
    await trimOpen();
    TRANSCRIPT.current = {
      utterances: [
        {
          track_id: "t1",
          speaker: "A",
          start: 9.8,
          end: 31.4,
          text: "one two three four ghost",
          words: WORDS,
        },
      ],
    };
    act(() => useDawStore.getState().hydrate(PATH, projectAt("h1")));
    dragTo("Out handle of A line", 30.5);
    await waitFor(() => expect(wire.post).toHaveBeenCalledOnce());
    expect(sent()).toEqual([
      ["UpdateSocialClip", { id: "s1", start: 10, end: 30.25 }],
    ]);
  });
});
