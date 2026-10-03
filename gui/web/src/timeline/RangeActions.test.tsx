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
    selectedTrackIds: [],
  }),
);

describe("range action bar and phone sheet", () => {
  it.each([false, true])(
    "renders all five actions and passes axe with sheet=%s",
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
});
