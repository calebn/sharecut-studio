import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { setChrome } from "../../test/chrome";
import { minimalProject, sessionRoster } from "../../test/fixtures";
import { stubMatchMedia } from "../../test/matchMedia";
import { StageFrame } from "./StageFrame";

// jsdom lays nothing out, so the fold is set by hand: the measurement has its own tests.
vi.mock("./useShortFrame", () => ({ useShortFrame: () => true }));

beforeEach(() => {
  stubMatchMedia(true);
  setChrome({ commandPaletteOpen: false });
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore
    .getState()
    .hydrate("share:folded-guest", minimalProject({ comments: [] }));
  useDawStore.setState({
    stage: "review",
    followingClientId: null,
    localClientId: "me",
    sessionClients: sessionRoster([
      {
        client_id: "me",
        role: "viewer",
        last_seen_ns: Date.now() * 1e6,
        meta: { display_name: "Me", color_index: 1 },
      },
      {
        client_id: "host",
        role: "host",
        last_seen_ns: Date.now() * 1e6,
        meta: { display_name: "Maya", color_index: 2 },
      },
    ]),
  });
});

const MENU = /^(More|Stage menu, Review)$/;

function mountGuest(guestMode: "view" | "comment") {
  useDawStore.setState({ guestMode });
  render(
    <StageFrame guestShare>
      <p>stage body</p>
    </StageFrame>,
  );
}

describe("StageFrame in a folded frame", () => {
  it.each(["view", "comment"] as const)(
    "keeps Follow for a %s link, which has no Project menu",
    async (guestMode) => {
      const user = userEvent.setup();
      mountGuest(guestMode);
      expect(screen.queryByRole("button", { name: /Project menu/ })).toBeNull();
      await user.click(screen.getByRole("button", { name: MENU }));
      await user.click(await screen.findByRole("menuitem", { name: /Maya/ }));
      await waitFor(() =>
        expect(useDawStore.getState().followingClientId).toBe("host"),
      );
    },
  );

  it.each(["view", "comment"] as const)(
    "keeps search for a %s link",
    async (guestMode) => {
      const user = userEvent.setup();
      mountGuest(guestMode);
      expect(screen.queryByRole("button", { name: /Palette/ })).toBeNull();
      await user.click(screen.getByRole("button", { name: MENU }));
      await user.click(
        await screen.findByRole("menuitem", {
          name: "Search commands and people",
        }),
      );
      await waitFor(() =>
        expect(useDawStore.getState().chrome.commandPaletteOpen).toBe(true),
      );
    },
  );
});
