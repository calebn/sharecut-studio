import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { minimalProject } from "../test/fixtures";
import { ToolModeToggle } from "./ToolModeToggle";

describe("ToolModeToggle", () => {
  beforeEach(() => {
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
});
