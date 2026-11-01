import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
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
import { requestHostDrain } from "../../services/offlineQueue/drainOfflineQueue";
import { useDawStore } from "../../state/dawStore";
import { commandLocks } from "../../test/commandLocks";
import { fakeExportServer } from "../../test/fakeExportServer";
import {
  minimalProject,
  sampleComment,
  sampleTrack,
} from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import type { HistoryEntryId } from "../../types/project";
import { ApiError } from "../../utils/apiError";
import { BounceFlowProvider } from "./bounceFlow";
import { DeliverStage as HostDeliverStage } from "./DeliverStage";
import { patchDeliverDraft } from "./deliverDraft";
import { ExportFlowProvider } from "./exportFlow";
import { ShareFlowProvider } from "./shareFlow";

function DeliverStage() {
  return (
    <ExportFlowProvider>
      <BounceFlowProvider>
        <ShareFlowProvider>
          <HostDeliverStage />
        </ShareFlowProvider>
      </BounceFlowProvider>
    </ExportFlowProvider>
  );
}

let runs = 0;
let PATH = "";
let OTHER = "";

const INTRO = { time: 0, title: "Intro" };
const MIDDLE = { time: 120, title: "Middle" };
const OUTRO = { time: 300, title: "Outro" };
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

const APPROVED = { ...CLIP, approved: true };

type Held = {
  chapters: { time: number; title: string }[];
  social_clips: (typeof CLIP)[];
};

function projectAt(head: string, held: Partial<Held> = {}) {
  const base = minimalProject();
  return minimalProject({
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
const setProject = (project: ReturnType<typeof projectAt>) =>
  act(() => useDawStore.getState().setProject(project));
const removeMiddle = () =>
  userEvent.click(screen.getByRole("button", { name: "Remove Middle" }));

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  fakeExportServer();
  runs += 1;
  PATH = `/tmp/deliver-host/${runs}/episode.sharecut`;
  OTHER = `/tmp/deliver-host/${runs}/other.project.json`;
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

describe("Deliver host Resolve fix", () => {
  it("picks the earliest open comment for Review", async () => {
    setProject(
      minimalProject({
        tracks: [sampleTrack()],
        timeline_duration_sec: 600,
        comments: [
          sampleComment({ id: "late", timeline_start: 90 }),
          sampleComment({ id: "done", timeline_start: 5, resolved: true }),
          sampleComment({ id: "early", timeline_start: 30 }),
        ],
      }),
    );
    render(<DeliverStage />);
    await userEvent.click(screen.getByRole("button", { name: /^Resolve/ }));
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "comment",
      id: "early",
    });
    expect(useDawStore.getState().stage).toBe("review");
  });
});

describe("Deliver host write-back through the command queue", () => {
  it("saves nothing on mount, even under StrictMode", () => {
    render(
      <StrictMode>
        <DeliverStage />
      </StrictMode>,
    );
    expect(wire.post).not.toHaveBeenCalled();
  });

  it("deletes a removed chapter by its time and title", async () => {
    render(<DeliverStage />);
    await removeMiddle();
    await waitFor(() =>
      expect(sent()).toEqual([
        ["DeleteChapter", { time: 120, title: "Middle" }],
      ]),
    );
  });

  it("adds a chapter at the playhead", async () => {
    render(<DeliverStage />);
    await userEvent.click(
      screen.getByRole("button", { name: /Add at playhead/ }),
    );
    await waitFor(() => expect(wire.post).toHaveBeenCalledOnce());
    expect(sent()[0]).toEqual([
      "AddChapter",
      { time: 300, title: "Chapter 3" },
    ]);
  });

  it("retitles a chapter in one command, not one per key", async () => {
    render(<DeliverStage />);
    const title = screen.getByRole("textbox", { name: "Title of Middle" });
    await userEvent.clear(title);
    await userEvent.type(title, "Centre{Enter}");
    await waitFor(() =>
      expect(sent()).toEqual([
        [
          "UpdateChapter",
          { old_time: 120, old_title: "Middle", time: 120, title: "Centre" },
        ],
      ]),
    );
  });

  it("retimes a chapter", async () => {
    render(<DeliverStage />);
    const time = screen.getByRole("textbox", { name: "Time of Middle" });
    await userEvent.clear(time);
    await userEvent.type(time, "3:00{Enter}");
    await waitFor(() =>
      expect(sent()).toEqual([
        [
          "UpdateChapter",
          { old_time: 120, old_title: "Middle", time: 180, title: "Middle" },
        ],
      ]),
    );
  });

  it("trims a clip", async () => {
    render(<DeliverStage />);
    await userEvent.click(
      screen.getByRole("button", { name: "More for A line" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Trim" }),
    );
    const out = screen.getByRole("textbox", { name: "Out of A line" });
    await userEvent.clear(out);
    await userEvent.type(out, "0:30{Enter}");
    await waitFor(() =>
      expect(sent()).toEqual([
        ["UpdateSocialClip", { id: "s1", start: 10, end: 30 }],
      ]),
    );
  });

  it("deletes a removed clip", async () => {
    render(<DeliverStage />);
    await userEvent.click(
      screen.getByRole("button", { name: "More for A line" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove" }),
    );
    await waitFor(() =>
      expect(sent()).toEqual([["DeleteSocialClip", { id: "s1" }]]),
    );
  });

  it("goes from loading to the stage when the project arrives", async () => {
    useDawStore.setState({ project: null });
    const { container } = render(<DeliverStage />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    setProject(projectAt("h1"));
    expect(
      await screen.findByRole("button", { name: "Remove Middle" }),
    ).toBeInTheDocument();
    expect(wire.post).not.toHaveBeenCalled();
  });
});

describe("Deliver host when a save does not land at once", () => {
  it("keeps the edit and says it is waiting when the server is busy", async () => {
    network.mode = "down";
    render(<DeliverStage />);
    await removeMiddle();
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Not saved yet");
    expect(status).toHaveTextContent("1 waiting to send");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Middle" })).toBeNull();
    expect(wire.rows).toHaveLength(1);
  });

  it("keeps the edit through a revision that arrives while it waits", async () => {
    network.mode = "down";
    render(<DeliverStage />);
    await removeMiddle();
    await screen.findByRole("status");
    setProject(projectAt("h2"));
    expect(screen.queryByRole("button", { name: "Remove Middle" })).toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("settles when the queue drains and the document catches up", async () => {
    network.mode = "down";
    render(<DeliverStage />);
    await removeMiddle();
    await screen.findByRole("status");
    network.mode = "up";
    await act(async () => requestHostDrain(PATH));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.queryByRole("button", { name: "Remove Middle" })).toBeNull();
    expect(useDawStore.getState().project?.chapters).toEqual([INTRO]);
    expect(wire.rows).toHaveLength(0);
  });

  it("keeps the page's edit and says so when the save is refused", async () => {
    network.mode = "refusing";
    render(<DeliverStage />);
    await removeMiddle();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not save your changes");
    expect(alert).not.toHaveTextContent("chapter not found");
    expect(screen.queryByRole("button", { name: "Remove Middle" })).toBeNull();
    await userEvent.click(
      within(alert).getByRole("button", { name: "Show the saved version" }),
    );
    expect(
      await screen.findByRole("button", { name: "Remove Middle" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the other project's chapters and writes only to it", async () => {
    network.mode = "refusing";
    render(<DeliverStage />);
    await removeMiddle();
    await screen.findByRole("alert");
    network.mode = "up";
    act(() =>
      useDawStore
        .getState()
        .hydrate(OTHER, projectAt("o1", { chapters: [OUTRO] })),
    );
    const outro = await screen.findByRole("button", { name: "Remove Outro" });
    expect(screen.queryByRole("button", { name: "Remove Intro" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await userEvent.click(outro);
    await waitFor(() => expect(wire.post).toHaveBeenCalledTimes(2));
    expect(wire.post.mock.calls[1]?.[0]).toBe(OTHER);
    expect(sent()[1]).toEqual(["DeleteChapter", { time: 300, title: "Outro" }]);
  });

  it("keeps the refusal for the first project while another is open", async () => {
    network.mode = "refusing";
    render(<DeliverStage />);
    await removeMiddle();
    await screen.findByRole("alert");
    act(() =>
      useDawStore
        .getState()
        .hydrate(OTHER, projectAt("o1", { chapters: [OUTRO] })),
    );
    await screen.findByRole("button", { name: "Remove Outro" });
    act(() => useDawStore.getState().hydrate(PATH, projectAt("h1")));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Middle" })).toBeNull();
  });

  it("does not let a save for the first project hold back the next one", async () => {
    let finish: () => void = () => {};
    wire.post.mockImplementationOnce(
      (_path: string, body) =>
        new Promise((resolve) => (finish = () => resolve(answer(body)))),
    );
    render(<DeliverStage />);
    await removeMiddle();
    await waitFor(() => expect(wire.post).toHaveBeenCalledOnce());
    act(() =>
      useDawStore
        .getState()
        .hydrate(OTHER, projectAt("o1", { chapters: [INTRO] })),
    );
    expect(
      await screen.findByRole("button", { name: "Remove Intro" }),
    ).toBeInTheDocument();
    await act(async () => finish());
    expect(
      screen.getByRole("button", { name: "Remove Intro" }),
    ).toBeInTheDocument();
  });
});

describe("Deliver host when a refusal needs the page back", () => {
  it("shows the saved version at once, even while another save is in flight", async () => {
    network.mode = "refusing";
    render(<DeliverStage />);
    const title = screen.getByRole("textbox", { name: "Title of Middle" });
    await userEvent.clear(title);
    await userEvent.type(title, "Mid2{Enter}");
    const alert = await screen.findByRole("alert");
    let finish: () => void = () => {};
    wire.post.mockImplementationOnce(
      (_path: string, body) =>
        new Promise((resolve) => (finish = () => resolve(answer(body)))),
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove Intro" }));
    await waitFor(() => expect(wire.post).toHaveBeenCalledTimes(2));
    await userEvent.click(
      within(alert).getByRole("button", { name: "Show the saved version" }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Title of Middle" }),
    ).toBeInTheDocument();
    network.mode = "up";
    await act(async () => finish());
  });

  it("says so when a waiting edit is refused as the queue drains", async () => {
    network.mode = "down";
    render(<DeliverStage />);
    const title = screen.getByRole("textbox", { name: "Title of Middle" });
    await userEvent.clear(title);
    await userEvent.type(title, "Mid2{Enter}");
    await screen.findByRole("status");
    network.mode = "refusing";
    await act(async () => requestHostDrain(PATH));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not save your changes");
    expect(
      screen.getByRole("textbox", { name: "Title of Mid2" }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(alert).getByRole("button", { name: "Show the saved version" }),
    );
    expect(
      await screen.findByRole("textbox", { name: "Title of Middle" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    {
      name: "a refused removal is dismissed",
      restore: async () => {
        await userEvent.click(
          within(screen.getByRole("alert")).getByRole("button", {
            name: "Show the saved version",
          }),
        );
      },
      mode: "refusing" as const,
    },
    {
      name: "the project brings the clip back",
      restore: async () =>
        setProject(projectAt("h3", { social_clips: [APPROVED] })),
      mode: "up" as const,
    },
  ])(
    "brings a clip back with the project's own title and approval when $name",
    async ({ restore, mode }) => {
      network.mode = mode;
      server.held.social_clips = [APPROVED];
      useDawStore
        .getState()
        .setProject(projectAt("h1", { social_clips: [APPROVED] }));
      render(<DeliverStage />);
      await userEvent.click(
        screen.getByRole("button", { name: "More for A line" }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Remove" }),
      );
      if (mode === "refusing") await screen.findByRole("alert");
      else await waitFor(() => expect(wire.post).toHaveBeenCalledOnce());
      await restore();
      expect(await screen.findByText("A line")).toBeInTheDocument();
      expect(screen.getByText("Approved")).toBeInTheDocument();
    },
  );

  it("shows a clip's title as text and offers no Approve", () => {
    render(<DeliverStage />);
    expect(screen.getByText("A line")).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Title of A line" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
  });
});

describe("Deliver host edits still being made when the page goes away", () => {
  const nudge = async () => {
    await userEvent.click(
      screen.getByRole("button", { name: "More for A line" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Trim" }),
    );
    screen.getByRole("slider", { name: "Out handle of A line" }).focus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(wire.post).not.toHaveBeenCalled();
  };

  it("sends the trim when the stage is left", async () => {
    const view = render(<DeliverStage />);
    await nudge();
    view.unmount();
    await waitFor(() => expect(wire.post).toHaveBeenCalledOnce());
    expect(sent()[0]?.[0]).toBe("UpdateSocialClip");
  });

  it("sends the trim once when the document changes under it", async () => {
    render(<DeliverStage />);
    await nudge();
    setProject(projectAt("h2", { chapters: [INTRO] }));
    await waitFor(() => expect(wire.post).toHaveBeenCalledOnce());
    expect(sent()[0]?.[0]).toBe("UpdateSocialClip");
  });

  it("sends a chapter title typed but not yet committed when the stage is left", async () => {
    const view = render(<DeliverStage />);
    const title = screen.getByRole("textbox", { name: "Title of Middle" });
    await userEvent.type(title, " two");
    expect(wire.post).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(wire.post).toHaveBeenCalledOnce());
    expect(sent()[0]).toEqual([
      "UpdateChapter",
      { old_time: 120, old_title: "Middle", time: 120, title: "Middle two" },
    ]);
  });
});

describe("Deliver host time text typed but not yet entered", () => {
  const renamed = { chapters: [{ time: 0, title: "Opening" }, MIDDLE] };

  it("sends a chapter time once when the document changes under it", async () => {
    render(<DeliverStage />);
    await userEvent.type(
      screen.getByRole("textbox", { name: "Time of Middle" }),
      "{Control>}a{/Control}2:30",
    );
    expect(wire.post).not.toHaveBeenCalled();
    setProject(projectAt("h2", renamed));
    await waitFor(() => expect(wire.post).toHaveBeenCalledOnce());
    expect(sent()[0]).toEqual([
      "UpdateChapter",
      { old_time: 120, old_title: "Middle", time: 150, title: "Middle" },
    ]);
  });

  it.each([
    { edge: "In", start: 12, end: 40 },
    { edge: "Out", start: 10, end: 42 },
  ])(
    "sends a clip $edge once when the document changes under it",
    async ({ edge, start, end }) => {
      render(<DeliverStage />);
      await userEvent.click(
        screen.getByRole("button", { name: "More for A line" }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Trim" }),
      );
      await userEvent.type(
        screen.getByRole("textbox", { name: `${edge} of A line` }),
        `{Control>}a{/Control}0:${edge === "In" ? "12" : "42"}`,
      );
      expect(wire.post).not.toHaveBeenCalled();
      setProject(projectAt("h2", renamed));
      await waitFor(() => expect(wire.post).toHaveBeenCalledOnce());
      expect(sent()[0]?.[0]).toBe("UpdateSocialClip");
      expect(JSON.stringify(sent()[0])).toContain(`"start":${start}`);
      expect(JSON.stringify(sent()[0])).toContain(`"end":${end}`);
    },
  );
});

describe("Deliver host clip trims", () => {
  it("sends one command for a burst of arrow presses", async () => {
    render(<DeliverStage />);
    await userEvent.click(
      screen.getByRole("button", { name: "More for A line" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Trim" }),
    );
    screen.getByRole("slider", { name: "Out handle of A line" }).focus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    expect(wire.post).not.toHaveBeenCalled();
    await userEvent.tab();
    await waitFor(() => expect(wire.post).toHaveBeenCalledOnce());
    expect(sent()[0]?.[0]).toBe("UpdateSocialClip");
    expect(sent()[0]?.[1]).toMatchObject({ id: "s1", start: 10 });
    expect(sent()[0]?.[1].end).toBeCloseTo(39.97, 5);
  });

  it("sends one command for a drag", async () => {
    render(<DeliverStage />);
    await userEvent.click(
      screen.getByRole("button", { name: "More for A line" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Trim" }),
    );
    const handle = screen.getByRole("slider", { name: "In handle of A line" });
    fireEvent.pointerDown(handle, { clientX: 10, pointerId: 1, buttons: 1 });
    for (const clientX of [20, 30, 40])
      fireEvent.pointerMove(handle, { clientX, pointerId: 1, buttons: 1 });
    expect(wire.post).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { pointerId: 1 });
    await waitFor(() => expect(wire.post).toHaveBeenCalledOnce());
  });
});

describe("Deliver host when the document changes elsewhere", () => {
  it.each([
    {
      name: "chapters",
      remove: removeMiddle,
      restored: () => screen.findByRole("button", { name: "Remove Middle" }),
    },
    {
      name: "clips",
      remove: async () => {
        await userEvent.click(
          screen.getByRole("button", { name: "More for A line" }),
        );
        await userEvent.click(
          await screen.findByRole("menuitem", { name: "Remove" }),
        );
      },
      restored: () => screen.findByText("A line"),
    },
  ])("shows the $name Undo brings back", async ({ remove, restored }) => {
    render(<DeliverStage />);
    await remove();
    await waitFor(() =>
      expect(useDawStore.getState().project?.history.head_id).toBe("s1"),
    );
    setProject(projectAt("h3"));
    expect(await restored()).toBeInTheDocument();
    expect(sent()).toHaveLength(1);
  });

  it("keeps an unsaved edit when a revision arrives during the save", async () => {
    let finish: () => void = () => {};
    wire.post.mockImplementationOnce(
      (_path: string, body) =>
        new Promise((resolve) => (finish = () => resolve(answer(body)))),
    );
    render(<DeliverStage />);
    await removeMiddle();
    await waitFor(() => expect(wire.post).toHaveBeenCalledOnce());
    setProject(projectAt("h2"));
    expect(screen.queryByRole("button", { name: "Remove Middle" })).toBeNull();
    await act(async () => finish());
    expect(screen.queryByRole("button", { name: "Remove Middle" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Remove Intro" }),
    ).toBeInTheDocument();
    expect(wire.post).toHaveBeenCalledOnce();
  });
});

describe("Deliver host when the stage is left and opened again", () => {
  it("shows the edit that is still waiting to send", async () => {
    network.mode = "down";
    const first = render(<DeliverStage />);
    await removeMiddle();
    await screen.findByText("Not saved yet");
    first.unmount();
    render(<DeliverStage />);
    expect(await screen.findByText("Not saved yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Middle" })).toBeNull();
  });

  it("shows the refused save and keeps the edit on the page", async () => {
    network.mode = "refusing";
    const first = render(<DeliverStage />);
    await removeMiddle();
    await screen.findByRole("alert");
    first.unmount();
    render(<DeliverStage />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not save your changes",
    );
    expect(screen.queryByRole("button", { name: "Remove Middle" })).toBeNull();
  });

  it("keeps a refusal that arrives after the stage was left", async () => {
    network.mode = "refusing";
    let finish: () => void = () => {};
    wire.post.mockImplementationOnce(
      (_path: string, body) =>
        new Promise((resolve) => (finish = () => resolve(answer(body)))),
    );
    const first = render(<DeliverStage />);
    await removeMiddle();
    await waitFor(() => expect(wire.post).toHaveBeenCalledOnce());
    first.unmount();
    await act(async () => finish());
    render(<DeliverStage />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("keeps how far the page was scrolled", () => {
    const first = render(<DeliverStage />);
    const page = first.container.querySelector<HTMLElement>(".dv-page");
    if (!page) throw new Error("no page");
    Object.defineProperty(page, "scrollTop", {
      configurable: true,
      value: 240,
    });
    fireEvent.scroll(page);
    first.unmount();
    expect(useDawStore.getState().stageViews.deliver?.panelScroll.body).toBe(
      240,
    );
  });
});

describe("Deliver host export while a save is in flight", () => {
  it("holds Export with the reason until the save lands", async () => {
    let finish: () => void = () => {};
    wire.post.mockImplementationOnce(
      (_path: string, body) =>
        new Promise((resolve) => (finish = () => resolve(answer(body)))),
    );
    render(<DeliverStage />);
    await removeMiddle();
    await waitFor(() => expect(wire.post).toHaveBeenCalledOnce());
    const held = screen.getAllByRole("button", { name: "Export" })[0];
    expect(held).toBeDisabled();
    expect(held).toHaveAttribute("title", "Saving your changes first.");
    await act(async () => finish());
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Export" })[0],
      ).toBeEnabled(),
    );
  });
});

describe("Deliver host clip removal", () => {
  it("offers no Undo, because the project cannot take a clip back", async () => {
    render(<DeliverStage />);
    await userEvent.click(
      screen.getByRole("button", { name: "More for A line" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove" }),
    );
    expect(screen.getByText("Removed A line")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    await waitFor(() => expect(wire.post).toHaveBeenCalledOnce());
    expect(screen.queryByText("A line")).toBeNull();
  });
});

describe("Deliver host values that follow the edits", () => {
  it("counts the chapters the page holds in Readiness", async () => {
    network.mode = "down";
    render(<DeliverStage />);
    const chapters = () =>
      screen
        .getByText("Chapters", { selector: ".sys-status-title" })
        .closest("li");
    expect(chapters()).toHaveTextContent("2");
    await userEvent.click(
      screen.getByRole("button", { name: /Add at playhead/ }),
    );
    expect(chapters()).toHaveTextContent("3");
    await removeMiddle();
    expect(chapters()).toHaveTextContent("2");
  });

  it("plays a trimmed clip from its new start", async () => {
    network.mode = "down";
    render(<DeliverStage />);
    await userEvent.click(
      screen.getByRole("button", { name: "More for A line" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Trim" }),
    );
    const start = screen.getByRole("textbox", { name: "In of A line" });
    await userEvent.clear(start);
    await userEvent.type(start, "0:15{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Play A line" }));
    expect(wire.seek).toHaveBeenCalledWith(15);
  });
});

describe("Deliver host refused-save banner", () => {
  const refusedAt = (
    createdAt: number,
    extra: { type?: string; dismissed?: boolean } = {},
  ) => ({
    kind: "refused" as const,
    reason: "refused",
    recovery: "edit-and-resubmit" as const,
    ...(extra.dismissed === undefined ? {} : { dismissed: extra.dismissed }),
    command: {
      command_id: `refused-${createdAt}-${extra.type ?? "DeleteChapter"}`,
      client_id: "tab-1",
      client_seq: 1,
      type: extra.type ?? "DeleteChapter",
      payload: { time: 120, title: "Middle" },
      structural_mode: "apply" as const,
      created_at: createdAt,
    },
  });
  const seed = (...conflicts: unknown[]) => {
    wire.conflicts[PATH] = conflicts;
  };
  const later = () => Date.now() + 60_000;

  it("shows a refused Deliver save made after the page opened", async () => {
    seed(refusedAt(later()));
    render(<DeliverStage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save your changes",
    );
  });

  it.each([
    {
      name: "dismissed",
      conflict: () => refusedAt(later(), { dismissed: true }),
    },
    { name: "older than the page", conflict: () => refusedAt(1) },
    {
      name: "not a refusal",
      conflict: () => ({
        ...refusedAt(later()),
        kind: "unknown" as const,
        recovery: "inspect-history" as const,
      }),
    },
    {
      name: "not a Deliver command",
      conflict: () => refusedAt(later(), { type: "SetTrackMeta" }),
    },
  ])("stays quiet for a refused save that is $name", async ({ conflict }) => {
    seed(conflict());
    render(<DeliverStage />);
    await screen.findByRole("textbox", { name: "Title of Middle" });
    await act(async () => requestHostDrain(PATH));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stays quiet for a refused save the person already acknowledged", async () => {
    const at = later();
    seed(refusedAt(at));
    patchDeliverDraft(PATH, () => ({ ackedAt: at }));
    render(<DeliverStage />);
    await screen.findByRole("textbox", { name: "Title of Middle" });
    await act(async () => requestHostDrain(PATH));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Deliver host readiness facts", () => {
  it("reports the seconds the edits removed as the Edits saved row", async () => {
    const base = projectAt("h1");
    useDawStore.getState().setProject({
      ...base,
      edit_impact: { ...base.edit_impact, total_removed_sec: 23.6 },
    });
    render(<DeliverStage />);
    const row = (await screen.findByText("Edits saved")).closest("li");
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("23.6 s");
  });
});
