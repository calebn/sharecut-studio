import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject } from "../../test/fixtures";
import { stubMatchMedia } from "../../test/matchMedia";
import { StageFrame } from "./StageFrame";

const PROJECT_PATH = "/tmp/stage-frame/episode.sharecut";

function mount() {
  return render(
    <StageFrame>
      <p>stage body</p>
    </StageFrame>,
  );
}

function bar() {
  return screen.getAllByRole("tablist", { name: "Stages" })[0];
}

beforeEach(() => {
  stubMatchMedia(false);
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.getState().hydrate(PROJECT_PATH, minimalProject());
  useDawStore.setState({ stage: "edit", guestMode: null });
});

describe("StageFrame header", () => {
  it("shows the title, the Stage bar, Invite and search around the stage body", () => {
    mount();
    expect(
      screen.getByRole("button", { name: /Test Episode/ }),
    ).toBeInTheDocument();
    expect(within(bar()).getAllByRole("tab")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Invite" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.getByRole("main", { name: "Edit" }).textContent).toBe(
      "stage body",
    );
  });

  it("opens the command palette from the search button", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: /Palette/ }));
    await waitFor(() =>
      expect(useDawStore.getState().chrome.commandPaletteOpen).toBe(true),
    );
  });

  it("disables Undo and Redo when the history has nothing to move", () => {
    mount();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
  });

  it("shows no save light for a guest, who has no host save state", () => {
    useDawStore.setState({ guestMode: "edit" });
    mount();
    expect(screen.queryByRole("status", { name: /Save/ })).toBeNull();
  });
});

describe("StageFrame stage switching", () => {
  it("switches stage through the Stage bar", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(within(bar()).getByRole("tab", { name: /Review/ }));
    expect(useDawStore.getState().stage).toBe("review");
    expect(within(bar()).getByRole("tab", { name: /Review/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("main", { name: "Review" })).toBeInTheDocument();
  });

  it("calls openStage with the chosen stage", async () => {
    const user = userEvent.setup();
    const openStage = vi.fn(useDawStore.getState().openStage);
    useDawStore.setState({ openStage });
    mount();
    await user.click(within(bar()).getByRole("tab", { name: /Prepare/ }));
    expect(openStage).toHaveBeenCalledWith("prepare", {});
  });

  it("hides the Player on Record and shows it elsewhere", async () => {
    const user = userEvent.setup();
    mount();
    expect(screen.getByRole("group", { name: "Player" })).toBeInTheDocument();
    await user.click(within(bar()).getByRole("tab", { name: /Record/ }));
    expect(screen.queryByRole("group", { name: "Player" })).toBeNull();
    await user.click(within(bar()).getByRole("tab", { name: /Deliver/ }));
    expect(screen.getByRole("group", { name: "Player" })).toBeInTheDocument();
  });

  it("badges Review with the decisions waiting", () => {
    useDawStore.getState().hydrate(
      PROJECT_PATH,
      minimalProject({
        edit_impact: {
          pending_review_count: 2,
          total_removed_sec: 0,
          by_track_sec: {},
        },
      }),
    );
    useDawStore.setState({ stage: "edit", guestMode: null });
    mount();
    expect(
      within(bar()).getByRole("tab", { name: /Review.*2, Needs you/ }),
    ).toBeInTheDocument();
  });
});

describe("StageFrame roles", () => {
  it("shows an Editor link Edit, Review and Deliver", () => {
    useDawStore.setState({ guestMode: "edit" });
    mount();
    expect(
      within(bar())
        .getAllByRole("tab")
        .map((tab) => tab.getAttribute("title")),
    ).toEqual(["Edit", "Review", "Deliver"]);
  });

  it("gives an Editor link no Invite: only the host shares", () => {
    useDawStore.setState({ guestMode: "edit" });
    mount();
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("gives a Viewer link no Stage bar at all", () => {
    useDawStore.setState({ guestMode: "view", stage: "review" });
    mount();
    expect(screen.queryByRole("tablist", { name: "Stages" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("drops A/B for a guest, who hears the mix only", () => {
    useDawStore.setState({ guestMode: "comment", stage: "review" });
    mount();
    expect(screen.queryByRole("button", { name: "A" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hear options" })).toBeNull();
  });

  it("puts the phone tab bar under the stage on a phone", () => {
    stubMatchMedia(true);
    mount();
    expect(document.querySelector(".stage-frame--phone")).not.toBeNull();
    expect(document.querySelectorAll(".sys-stage-bar--tabs")).toHaveLength(1);
  });
});
