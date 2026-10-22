import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { makeRangeTarget } from "../edit/rangeSelection";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { RangeActions } from "./RangeActions";

const project = minimalProject({
  tracks: [
    sampleTrack({ id: "a", label: "Speaker", range_media_seal: "seal" }),
  ],
  clips: {
    tracks: {
      a: [
        clipRow({
          track_id: "a",
          timeline_start: 0,
          timeline_end: 5,
          source_start: 0,
          source_end: 5,
        }),
      ],
    },
    clip_count: 1,
  },
});
const target = makeRangeTarget(project, [{ start: 1, end: 2 }], ["a"])!;

beforeEach(() =>
  useDawStore.setState({
    project,
    projectPath: "/tmp/episode",
    selection: { kind: "range", target },
    rangeArmed: false,
    rangeBusy: false,
    guestMode: null,
    shareCapabilities: null,
    joinMutationInFlight: false,
    sessionRegion: null,
  }),
);

describe("range action bar and phone sheet", () => {
  it.each([false, true])(
    "renders all six actions and passes axe with sheet=%s",
    async (sheet) => {
      const { container } = render(
        <main>
          <RangeActions sheet={sheet} />
        </main>,
      );
      expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
        "Play",
        "Cut",
        "Mute",
        "Fill room tone",
        "Comment",
        "Bounce",
        "Clear range",
      ]);
      expect(screen.getByText(/1.00–2.00 s · Speaker/)).toBeTruthy();
      await expectNoA11yViolations(container);
    },
  );
  it("shows disabled guest actions with readable reasons", async () => {
    useDawStore.setState({
      projectPath: "share:token",
      guestMode: "view",
      shareCapabilities: ["view"],
    });
    const { container } = render(
      <main>
        <RangeActions />
      </main>,
    );
    expect(screen.getByRole("button", { name: "Suggest cut" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Comment" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Bounce" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Suggest cut" }),
    ).toHaveAccessibleDescription("This share cannot suggest edits");
    await expectNoA11yViolations(container);
  });
  it("requires deliberate lane selection for numeric and agent ranges", async () => {
    const user = userEvent.setup();
    useDawStore.setState({
      selection: null,
      rangeArmed: true,
      sessionRegion: { start_sec: 3, end_sec: 4 },
      playheadSec: 9,
      followingClientId: "agent",
    });
    render(<RangeActions sheet />);
    await user.click(screen.getByRole("button", { name: "Select range" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "choose at least one track",
    );
    await user.click(screen.getByRole("checkbox", { name: "Speaker" }));
    await user.click(
      screen.getByRole("button", {
        name: "Use agent range on selected tracks",
      }),
    );
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "range",
      target: { track_ids: ["a"], intervals: [{ start: 3, end: 4 }] },
    });
    expect(useDawStore.getState().playheadSec).toBe(9);
    expect(useDawStore.getState().followingClientId).toBe("agent");
  });
  it("clears the ticked scope once the agent range is adopted", async () => {
    const user = userEvent.setup();
    useDawStore.setState({
      selection: null,
      sessionRegion: { start_sec: 3, end_sec: 4 },
    });
    render(<RangeActions sheet />);
    await user.click(screen.getByRole("checkbox", { name: "Speaker" }));
    expect(useDawStore.getState().rangeScopeTrackIds).toEqual(["a"]);
    await user.click(
      screen.getByRole("button", {
        name: "Use agent range on selected tracks",
      }),
    );
    expect(useDawStore.getState().rangeScopeTrackIds).toBeNull();
  });
  it("clears a track selection made while armed when the range is cancelled", async () => {
    const user = userEvent.setup();
    useDawStore.setState({
      rangeArmed: true,
      selection: { kind: "track", trackId: "a" },
    });
    render(<RangeActions sheet />);
    await user.click(
      screen.getByRole("button", { name: "Cancel range selection" }),
    );
    expect(useDawStore.getState().selection).toBeNull();
  });
  it("offers Move to the sibling speaker track", () => {
    const ana = sampleTrack({
      id: "room",
      label: "Ana",
      speaker_split_id: "split_1",
      range_media_seal: "room",
    });
    const ben = sampleTrack({
      id: "room_ben",
      label: "Ben",
      speaker_split_id: "split_1",
      range_media_seal: "room_ben",
    });
    const splitProject = minimalProject({
      tracks: [ana, ben],
      clips: {
        tracks: {
          room: [
            clipRow({
              track_id: "room",
              timeline_start: 0,
              timeline_end: 10,
              source_start: 0,
              source_end: 10,
            }),
          ],
          room_ben: [
            clipRow({
              track_id: "room_ben",
              timeline_start: 0,
              timeline_end: 10,
              source_start: 0,
              source_end: 10,
            }),
          ],
        },
        clip_count: 2,
      },
    });
    const splitTarget = makeRangeTarget(
      splitProject,
      [{ start: 1, end: 1.4 }],
      ["room"],
    )!;
    useDawStore.setState({
      project: splitProject,
      selection: { kind: "range", target: splitTarget },
    });
    render(<RangeActions />);
    expect(screen.getByRole("button", { name: "Move to Ben" })).toBeVisible();
  });
});
