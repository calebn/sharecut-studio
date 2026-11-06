import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { ToolsButton } from "./ToolsButton";

let viewport: "phone" | "tablet" = "phone";
vi.mock("../../hooks/useViewportClass", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useViewportClass")>()),
  useViewportClass: () => viewport,
}));

beforeEach(() => {
  viewport = "phone";
  useDawStore
    .getState()
    .hydrate("/tmp/tools/p.json", minimalProject({ tracks: [sampleTrack()] }));
  useDawStore.setState({
    guestMode: null,
    rangeArmed: false,
    editSurface: "lanes",
    openSheet: null,
  });
});

describe("folded Tools button", () => {
  it("names an armed range and marks the button only while one is armed", () => {
    const { rerender } = render(<ToolsButton />);
    const idle = screen.getByRole("button", { name: "Tools, Timeline" });
    expect(idle.hasAttribute("data-range-armed")).toBe(false);

    useDawStore.setState({ rangeArmed: true });
    rerender(<ToolsButton />);
    const armed = screen.getByRole("button", {
      name: "Tools, Timeline, range armed",
    });
    expect(armed.hasAttribute("data-range-armed")).toBe(true);
    expect(armed.getAttribute("title")).toBe("Tools");
  });

  it("names an armed range without the surface off the phone", () => {
    viewport = "tablet";
    useDawStore.setState({ rangeArmed: true });
    render(<ToolsButton />);
    expect(
      screen.getByRole("button", { name: "Tools, range armed" }),
    ).toBeTruthy();
  });
});
