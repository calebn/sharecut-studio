import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject } from "../../test/fixtures";
import { PlayerBar } from "./PlayerBar";

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore
    .getState()
    .hydrate("/tmp/player-bar/episode.project.json", minimalProject());
  useDawStore.setState({ auditionMode: "mix", guestMode: null });
});

afterEach(() => vi.restoreAllMocks());

const audition = () => useDawStore.getState().auditionMode;

describe("PlayerBar", () => {
  it("hears the original while A is held and goes back to the mode it left", async () => {
    useDawStore.setState({ auditionMode: "fx" });
    render(<PlayerBar />);
    const a = screen.getByRole("button", { name: "A" });
    fireEvent.pointerDown(a, { button: 0 });
    await waitFor(() => expect(audition()).toBe("raw"));
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 600);
    fireEvent.pointerUp(a);
    await waitFor(() => expect(audition()).toBe("fx"));
  });

  it("latches the original on a quick press, and B goes back to the mix", async () => {
    const user = userEvent.setup();
    render(<PlayerBar />);
    await user.click(screen.getByRole("button", { name: "A" }));
    await waitFor(() => expect(audition()).toBe("raw"));
    await user.click(screen.getByRole("button", { name: "B" }));
    await waitFor(() => expect(audition()).toBe("mix"));
  });

  it("picks Without mix processing from the hear menu", async () => {
    const user = userEvent.setup();
    render(<PlayerBar />);
    fireEvent.contextMenu(screen.getByRole("group", { name: "Audition" }));
    await user.click(
      await screen.findByRole("menuitemradio", {
        name: "Without mix processing",
      }),
    );
    await waitFor(() => expect(audition()).toBe("fx"));
  });

  it("is empty until a project is open", () => {
    useDawStore.setState({ project: null });
    const { container } = render(<PlayerBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it("gives a guest the mix only: no A/B and no hear menu", () => {
    useDawStore.setState({ guestMode: "edit" });
    render(<PlayerBar />);
    expect(screen.queryByRole("group", { name: "Audition" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hear options" })).toBeNull();
  });
});
