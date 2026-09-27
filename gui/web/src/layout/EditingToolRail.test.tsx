import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { EditingToolRail } from "./EditingToolRail";

const bladeCutState = vi.hoisted(() => ({
  allowed: true,
  busy: false,
  error: null as string | null,
  bladeConfirmSec: null as number | null,
  trackIdsForCut: ["host"] as readonly string[],
}));

vi.mock("../hooks/useBladeCut", () => ({
  useBladeCut: () => bladeCutState,
}));

const execute = vi.hoisted(() => vi.fn());
vi.mock("../commands/execute", () => ({ execute }));

describe("EditingToolRail", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    Object.assign(bladeCutState, {
      allowed: true,
      busy: false,
      error: null,
      bladeConfirmSec: null,
      trackIdsForCut: ["host"],
    });
    execute.mockClear();
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

  it("confirms a cut by dispatching bladeCut.confirm then tool.blade", async () => {
    const user = userEvent.setup();
    bladeCutState.bladeConfirmSec = 5;
    render(<EditingToolRail />);
    await user.click(screen.getByRole("button", { name: "Cut" }));
    expect(execute).toHaveBeenNthCalledWith(
      1,
      "edit.bladeCut.confirm",
      {},
      { skipWhen: true },
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      "tool.blade",
      {},
      { skipWhen: true },
    );
  });

  it("cancels a cut by dispatching bladeCut.cancel", async () => {
    const user = userEvent.setup();
    bladeCutState.bladeConfirmSec = 5;
    render(<EditingToolRail />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(execute).toHaveBeenCalledWith(
      "edit.bladeCut.cancel",
      {},
      { skipWhen: true },
    );
  });
});
