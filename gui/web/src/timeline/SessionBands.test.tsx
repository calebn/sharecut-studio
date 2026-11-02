import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadHostRecordSessions } from "../api";
import { seekTransport } from "../commands/seek";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
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
    expect(await pill(/^Session 1, select its clips$/)).toHaveTextContent("S1");
    expect(
      await pill(/^Session 2 - Pickups, select its clips$/),
    ).toHaveTextContent("S2");
  });

  it("pressing a pill selects the session's clips and seeks to its start, not through the ruler", async () => {
    hydrate();
    render(<Ruler />);
    const s2 = await pill(/^Session 2/);
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
    expect(seekTransport).toHaveBeenCalledTimes(1);
    expect(onSeek).not.toHaveBeenCalled();
    expect(s2).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Session 1/ })).toHaveAttribute(
      "aria-pressed",
      "false",
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

  it("has no axe violations", async () => {
    hydrate();
    const { container } = render(<Ruler />);
    await pill(/^Session 1/);
    await expectNoA11yViolations(container);
  });
});
