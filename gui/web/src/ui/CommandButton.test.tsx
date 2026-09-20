import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { registerDawCommands } from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { CommandButton } from "./CommandButton";

describe("CommandButton", () => {
  beforeEach(() => {
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("runs execute on click and is axe-clean", async () => {
    const user = userEvent.setup();
    useDawStore.getState().setIsPlaying(false);
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <CommandButton commandId="transport.togglePlay">Play</CommandButton>
      </DawProvider>,
    );
    expect(screen.getByRole("button", { name: "Play" })).toHaveClass(
      "ui-control",
    );
    await user.click(screen.getByRole("button", { name: "Play" }));
    expect(useDawStore.getState().isPlaying).toBe(true);
    await expectNoA11yViolations(container);
  });

  it("bare mode still applies ui-control", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <CommandButton
          bare
          commandId="transport.togglePlay"
          className="play-btn"
        >
          Play
        </CommandButton>
      </DawProvider>,
    );
    expect(screen.getByRole("button", { name: "Play" })).toHaveClass(
      "ui-control",
      "play-btn",
    );
  });
});
