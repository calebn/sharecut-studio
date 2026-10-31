import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RecordSessionSummary } from "../../record";
import { expectNoA11yViolations } from "../../test/a11y";
import { EndedSessionCard } from "./EndedSessionCard";

const base: RecordSessionSummary = {
  session_id: "s1",
  number: 2,
  state: "ended",
  target_kind: null,
  takes: [
    { take_index: 0, recording_ms: 360_000 },
    { take_index: 1, recording_ms: 300_000 },
    { take_index: 2, recording_ms: 64_000 },
  ],
  participants: [
    { participant_id: "a", display_name: "Ava", role: "guest", track_id: "t1" },
    { participant_id: "b", display_name: "Sam", role: "guest", track_id: null },
  ],
  landed: true,
  ended_at: "2026-10-25T12:00:00Z",
};
const names = new Map([["t1", "Ava"]]);

const mount = (over: Partial<RecordSessionSummary> = {}) =>
  render(
    <EndedSessionCard session={{ ...base, ...over }} trackNames={names} />,
  );

describe("EndedSessionCard", () => {
  it("shows the numbered heading with the date, the take line and mapping rows", async () => {
    const { container } = mount();
    const region = screen.getByRole("region", {
      name: "Session 2 · Sun 25 Oct",
    });
    expect(within(region).getByText("3 takes · 12:04")).toBeInTheDocument();
    const rows = within(region).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      "Ava → to Ava",
      "Sam → to New track",
    ]);
    await expectNoA11yViolations(container);
  });

  it("falls back to Last session and omits a missing date", () => {
    mount({ number: null, ended_at: null });
    expect(
      screen.getByRole("heading", { name: "Last session" }),
    ).toBeInTheDocument();
  });

  it("names only the participant when the session never landed", () => {
    mount({ landed: false, number: null });
    expect(screen.getAllByRole("listitem").map((r) => r.textContent)).toEqual([
      "Ava",
      "Sam",
    ]);
  });

  it("falls back to Guest for a blank name and flags a removed track", () => {
    mount({
      participants: [
        {
          participant_id: "a",
          display_name: "  ",
          role: "guest",
          track_id: null,
        },
        {
          participant_id: "b",
          display_name: "Sam",
          role: "guest",
          track_id: "gone",
        },
      ],
    });
    expect(screen.getAllByRole("listitem").map((r) => r.textContent)).toEqual([
      "Guest → to New track",
      "Sam → to Track removed",
    ]);
  });

  it("says No takes and formats hours", () => {
    const { rerender } = mount({ takes: [] });
    expect(screen.getByText("No takes")).toBeInTheDocument();
    rerender(
      <EndedSessionCard
        session={{
          ...base,
          takes: [{ take_index: 0, recording_ms: 3_725_000 }],
        }}
        trackNames={names}
      />,
    );
    expect(screen.getByText("1 take · 1:02:05")).toBeInTheDocument();
  });

  describe("Edit hand-off", () => {
    const edit = (
      over: Partial<RecordSessionSummary> = {},
      props: Partial<React.ComponentProps<typeof EndedSessionCard>> = {},
    ) => {
      const onEdit = vi.fn();
      const view = render(
        <EndedSessionCard
          session={{ ...base, ...over }}
          trackNames={names}
          hasClips
          onEdit={onEdit}
          {...props}
        />,
      );
      return { onEdit, ...view };
    };

    it("offers Edit Session N as the primary action and calls back", async () => {
      const { onEdit, baseElement } = edit();
      const button = screen.getByRole("button", { name: "Edit Session 2" });
      expect(button).toHaveClass("primary");
      await expectNoA11yViolations(baseElement);
      await userEvent.click(button);
      expect(onEdit).toHaveBeenCalledTimes(1);
    });

    it("reads Edit session when the session has no number", () => {
      edit({ number: null });
      expect(
        screen.getByRole("button", { name: "Edit session" }),
      ).toBeInTheDocument();
    });

    it("is absent without clips, before landing or without a handler", () => {
      const cases: [Partial<RecordSessionSummary>, object][] = [
        [{}, { hasClips: false }],
        [{ landed: false }, {}],
        [{}, { onEdit: undefined }],
      ];
      for (const [over, props] of cases) {
        const { unmount } = edit(over, props);
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
        unmount();
      }
    });
  });

  describe("track menu", () => {
    const tracks = [
      { id: "t1", label: "Ava" },
      { id: "t2", label: "Host" },
    ];
    const menuMount = (
      over: Partial<RecordSessionSummary> = {},
      props: Partial<React.ComponentProps<typeof EndedSessionCard>> = {},
    ) => {
      const onRemap = vi.fn();
      const view = render(
        <EndedSessionCard
          session={{ ...base, ...over }}
          trackNames={new Map(tracks.map((t) => [t.id, t.label]))}
          tracks={tracks}
          movable={new Set(["a", "b"])}
          onRemap={onRemap}
          {...props}
        />,
      );
      return { onRemap, ...view };
    };

    it("lists the tracks with the current one checked and moves on pick", async () => {
      const { onRemap, baseElement } = menuMount();
      await userEvent.click(
        screen.getByRole("button", { name: "Track for Ava: Ava" }),
      );
      const menu = screen.getByRole("menu", { name: "Track for Ava" });
      const items = within(menu).getAllByRole("menuitemradio");
      expect(items.map((i) => i.textContent)).toEqual(["Ava", "Host"]);
      expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual([
        "true",
        "false",
      ]);
      await expectNoA11yViolations(baseElement);
      await userEvent.click(items[1]);
      expect(onRemap).toHaveBeenCalledWith("a", "t2");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("does nothing when the current track is picked again", async () => {
      const { onRemap } = menuMount();
      await userEvent.click(
        screen.getByRole("button", { name: "Track for Ava: Ava" }),
      );
      await userEvent.click(screen.getByRole("menuitemradio", { name: "Ava" }));
      expect(onRemap).not.toHaveBeenCalled();
    });

    it("says Several tracks for a participant spread over tracks, menu still there", () => {
      menuMount();
      expect(
        screen.getByRole("button", { name: "Track for Sam: Several tracks" }),
      ).toBeInTheDocument();
    });

    it("stays plain text when not landed, with one track, without clips or without a handler", () => {
      const cases: [Partial<RecordSessionSummary>, object][] = [
        [{ landed: false }, {}],
        [{}, { tracks: [tracks[0]] }],
        [{}, { movable: new Set<string>() }],
        [{}, { onRemap: undefined }],
      ];
      for (const [over, props] of cases) {
        const { unmount } = menuMount(over, props);
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
        unmount();
      }
    });

    it("shows the track label, not New track, when no clips were found", () => {
      menuMount({}, { movable: new Set<string>() });
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.getAllByRole("listitem")[0].textContent).toBe(
        "Ava → to Ava",
      );
    });

    it("ends the menu with New track, even with a single project track", async () => {
      const onNewTrack = vi.fn();
      const { baseElement } = menuMount(
        {},
        { tracks: [tracks[0]], onNewTrack },
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Track for Ava: Ava" }),
      );
      const menu = screen.getByRole("menu", { name: "Track for Ava" });
      expect(
        [
          ...within(menu).getAllByRole("menuitemradio"),
          ...within(menu).getAllByRole("menuitem"),
        ].map((i) => i.textContent),
      ).toEqual(["Ava", "New track"]);
      await expectNoA11yViolations(baseElement);
      await userEvent.click(
        within(menu).getByRole("menuitem", { name: "New track" }),
      );
      expect(onNewTrack).toHaveBeenCalledWith("a");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("hides New track without clips or before landing", () => {
      menuMount({}, { movable: new Set<string>(), onNewTrack: vi.fn() });
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("disables the trigger while busy", () => {
      menuMount({}, { busy: true });
      expect(
        screen.getByRole("button", { name: "Track for Ava: Ava" }),
      ).toBeDisabled();
    });
  });
});
