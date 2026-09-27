import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { registerDawCommands } from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { minimalProject } from "../test/fixtures";
import { ToolModeToggle } from "./ToolModeToggle";

describe("ToolModeToggle", () => {
  beforeEach(() => {
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("includes Comment when expanded", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <ToolModeToggle />
      </DawProvider>,
    );
    expect(screen.getByRole("button", { name: "Select" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Blade" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Comment" })).toBeTruthy();
  });

  it("renders the shared segmented track so pressed paint comes from one place", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <ToolModeToggle />
      </DawProvider>,
    );
    const group = screen.getByRole("group", { name: "Timeline tool" });
    expect(group.classList.contains("ui-segmented")).toBe(true);
    expect(group.classList.contains("tool-mode-toggle")).toBe(true);
  });

  it("omits Comment when compact so collapsed transport owns it", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <ToolModeToggle compact />
      </DawProvider>,
    );
    expect(screen.getByRole("button", { name: "Select" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Blade" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
  });

  it("dispatches tool and comment commands through the store on click", async () => {
    const user = userEvent.setup();
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <ToolModeToggle />
      </DawProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Blade" }));
    expect(useDawStore.getState().toolMode).toBe("blade");
    await user.click(screen.getByRole("button", { name: "Select" }));
    expect(useDawStore.getState().toolMode).toBe("select");
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(useDawStore.getState().commentMode).toBe(true);
  });
});
