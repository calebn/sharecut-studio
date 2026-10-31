import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { DawProvider } from "../../state/store";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { TrackColumn, type TrackColumnProps } from "./TrackColumn";

const PATH = "/tmp/p.json";

function mount(props: TrackColumnProps = {}) {
  const initial = minimalProject({
    tracks: [
      sampleTrack({ id: "host", label: "Host" }),
      sampleTrack({ id: "guest", label: "Guest" }),
    ],
  });
  useDawStore.getState().hydrate(PATH, initial);
  return render(
    <DawProvider projectPath={PATH} initialProject={initial}>
      <TrackColumn {...props} />
    </DawProvider>,
  );
}

describe("TrackColumn Solo on chip", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
  });
  afterEach(() => {
    useDawStore.getState().setSoloMap({});
    clearRegisteredCommands();
  });

  it("shows Solo on · Clear solo in the ruler corner above the tracks while any track is soloed, and clears it", async () => {
    const user = userEvent.setup();
    const { container } = mount({ showSoloChip: true });
    expect(
      screen.queryByRole("button", { name: "Solo on · Clear solo" }),
    ).toBeNull();

    act(() => useDawStore.getState().setSoloMap({ host: true }));
    const chip = screen.getByRole("button", { name: "Solo on · Clear solo" });
    const corner = screen
      .getByRole("group", { name: "Tracks" })
      .querySelector(":scope > .track-headers-chrome");
    expect(chip.parentElement).toBe(corner);
    expect(corner?.nextElementSibling).toHaveClass("track-column-row");
    expect(chip).toHaveAttribute(
      "title",
      "Other tracks are silent for you only. Clear solo plays every track again",
    );
    await expectNoA11yViolations(container);

    await user.tab();
    expect(chip).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(useDawStore.getState().soloTracks).toEqual({});
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Solo off. Every track plays again.",
    );
    expect(
      screen.queryByRole("button", { name: "Solo on · Clear solo" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Solo Host" })).toHaveFocus();
  });

  it("sends focus to the first S button when several tracks were soloed", async () => {
    const user = userEvent.setup();
    mount({ showSoloChip: true });
    act(() => useDawStore.getState().setSoloMap({ host: true, guest: true }));
    screen.getByRole("button", { name: "Solo on · Clear solo" }).focus();
    await user.keyboard(" ");
    expect(useDawStore.getState().soloTracks).toEqual({});
    expect(screen.getByRole("button", { name: "Solo Host" })).toHaveFocus();
  });

  it("leaves the phone rail corner empty: the phone form has no chip", () => {
    mount({ form: "phone" });
    act(() => useDawStore.getState().setSoloMap({ host: true }));
    expect(
      screen.queryByRole("button", { name: "Solo on · Clear solo" }),
    ).toBeNull();
  });
});
