import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { EditingToolRail } from "./EditingToolRail";

vi.mock("../hooks/useBladeCut", () => ({
  useBladeCut: () => ({
    allowed: true,
    busy: false,
    error: null,
    bladeConfirmSec: null,
    trackIdsForCut: ["host"],
  }),
}));

describe("EditingToolRail", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("hides cut-at-playhead while comment mode is on", () => {
    useDawStore.setState({ toolMode: "blade", commentMode: true });
    render(<EditingToolRail />);
    expect(
      screen.queryByRole("button", { name: /Cut at playhead/i }),
    ).toBeNull();
  });

  it("shows cut-at-playhead in blade mode when comment mode is off", () => {
    useDawStore.setState({ toolMode: "blade", commentMode: false });
    render(<EditingToolRail />);
    expect(
      screen.getByRole("button", { name: /Cut at playhead/i }),
    ).toBeTruthy();
  });
});
