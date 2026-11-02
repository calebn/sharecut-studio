import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadHostRecordSessions } from "../api";
import { seekTransport } from "../commands/seek";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import type { HistoryEntryId } from "../types/project";
import {
  RECORDED_SESSIONS_RESPONSE,
  recordedSessionsProject,
} from "./sessionBandsFixture";
import { TimelineRuler } from "./TimelineRuler";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  loadHostRecordSessions: vi.fn(),
}));
vi.mock("../commands/seek", () => ({ seekTransport: vi.fn() }));

const onSeek = vi.fn();

function Ruler() {
  return (
    <TimelineRuler
      canvasWidthPx={1000}
      viewportPx={800}
      sessionSec={100}
      zoomPxPerSec={10}
      fixedPlayhead={false}
      onSeek={onSeek}
      onFit={vi.fn()}
    />
  );
}

function hydrate(guest = false) {
  const project = recordedSessionsProject();
  useDawStore
    .getState()
    .hydrate(
      guest ? "share:episode" : project.project_path,
      project,
      guest ? "viewer" : null,
    );
}

function advanceHistory(headId: string) {
  act(() =>
    useDawStore.setState((s) =>
      s.project
        ? {
            project: {
              ...s.project,
              history: {
                ...s.project.history,
                head_id: headId as HistoryEntryId,
              },
            },
          }
        : s,
    ),
  );
}

const pill = (name: RegExp) => screen.findByRole("button", { name });

beforeEach(() => {
  vi.mocked(loadHostRecordSessions).mockResolvedValue(
    RECORDED_SESSIONS_RESPONSE.sessions,
  );
});

afterEach(() => {
  vi.clearAllMocks();
  useDawStore.setState({ project: null, selection: null, scrollLeft: 0 });
});

describe("session bands on the Edit ruler", () => {
  it("draws an S<n> pill per session, named in full", async () => {
    hydrate();
    render(<Ruler />);
    expect(await pill(/^S1, Session 1: select its clips$/)).toHaveTextContent(
      "S1",
    );
    expect(
      await pill(/^S2, Session 2 - Pickups: select its clips$/),
    ).toHaveTextContent("S2");
  });

  it("names each pill starting with its visible text", async () => {
    hydrate();
    render(<Ruler />);
    for (const button of await screen.findAllByRole("button", {
      name: /^S\d/,
    })) {
      const name = button.getAttribute("aria-label") ?? "";
      expect(name.startsWith(button.textContent ?? "?")).toBe(true);
    }
  });

  it("pressing a pill selects the session's clips and seeks to its start, not through the ruler", async () => {
    hydrate();
    render(<Ruler />);
    const s2 = await pill(/^S2,/);
    fireEvent.pointerDown(s2);
    fireEvent.click(s2);
    const selection = useDawStore.getState().selection;
    expect(selection?.kind).toBe("clip");
    const ids = selection && "ids" in selection ? (selection.ids ?? []) : [];
    const tracks = useDawStore.getState().project?.clips.tracks ?? {};
    const expected = Object.values(tracks)
      .flat()
      .filter((c) => c.source_id?.startsWith("rec-s2-"))
      .map((c) => c.id);
    expect([...ids].sort()).toEqual(expected.sort());
    const s2Start = Math.min(
      ...Object.values(tracks)
        .flat()
        .filter((c) => c.source_id?.startsWith("rec-s2-"))
        .map((c) => c.timeline_start),
    );
    expect(seekTransport).toHaveBeenCalledExactlyOnceWith(s2Start);
    expect(onSeek).not.toHaveBeenCalled();
    expect(s2).toHaveAttribute("aria-current", "true");
    expect(s2).not.toHaveAttribute("aria-pressed");
    expect(screen.getByRole("button", { name: /^S1,/ })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("draws no pills for a guest and does not fetch", async () => {
    hydrate(true);
    render(<Ruler />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /^Session/ })).toBeNull();
    expect(loadHostRecordSessions).not.toHaveBeenCalled();
  });

  it("draws no pills when the sessions fetch fails", async () => {
    vi.mocked(loadHostRecordSessions).mockRejectedValue(new Error("down"));
    hydrate();
    render(<Ruler />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /^Session/ })).toBeNull();
    expect(
      screen.getByRole("slider", { name: "Timeline position" }),
    ).toBeVisible();
  });

  it("refetches when the history head changes and shows the new name", async () => {
    hydrate();
    render(<Ruler />);
    await pill(/^S2, Session 2 - Pickups:/);
    vi.mocked(loadHostRecordSessions).mockResolvedValue([
      RECORDED_SESSIONS_RESPONSE.sessions[0],
      { ...RECORDED_SESSIONS_RESPONSE.sessions[1], name: "Retakes" },
    ]);
    advanceHistory("h2");
    expect(await pill(/^S2, Session 2 - Retakes:/)).toBeVisible();
    expect(loadHostRecordSessions).toHaveBeenCalledTimes(2);
  });

  it("keeps the pills while a refetch is pending", async () => {
    hydrate();
    render(<Ruler />);
    await pill(/^S2,/);
    vi.mocked(loadHostRecordSessions).mockReturnValue(new Promise(() => {}));
    advanceHistory("h2");
    await act(async () => {});
    expect(screen.getByRole("button", { name: /^S2,/ })).toBeVisible();
  });

  it("keeps the last good pills when a refetch fails", async () => {
    hydrate();
    render(<Ruler />);
    await pill(/^S2,/);
    vi.mocked(loadHostRecordSessions).mockRejectedValue(new Error("down"));
    advanceHistory("h2");
    await act(async () => {});
    expect(screen.getByRole("button", { name: /^S2,/ })).toBeVisible();
  });

  it("stacks a pill that starts inside an earlier band to the right of it", async () => {
    const project = recordedSessionsProject();
    const first = Object.values(project.clips.tracks)[0][0];
    const tracks = {
      ...project.clips.tracks,
      nested: [
        {
          ...first,
          id: "nested",
          source_id: "rec-s3-0-x",
          timeline_start: first.timeline_start + 1,
          timeline_end: first.timeline_start + 5,
        },
      ],
    };
    useDawStore.getState().hydrate(project.project_path, {
      ...project,
      clips: { ...project.clips, tracks },
    });
    vi.mocked(loadHostRecordSessions).mockResolvedValue([
      ...RECORDED_SESSIONS_RESPONSE.sessions,
      {
        ...RECORDED_SESSIONS_RESPONSE.sessions[0],
        session_id: "s3",
        number: 3,
      },
    ]);
    render(<Ruler />);
    const stack = async (re: RegExp) =>
      (await pill(re)).style.getPropertyValue("--session-stack");
    expect(await stack(/^S1,/)).toBe("0");
    expect(await stack(/^S3,/)).toBe("1");
  });

  it("has no axe violations", async () => {
    hydrate();
    const { container } = render(<Ruler />);
    await pill(/^S1,/);
    await expectNoA11yViolations(container);
  });
});
