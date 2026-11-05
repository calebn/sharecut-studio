import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupCard } from "./SetupCard";

const noop = () => {};

describe("SetupCard checking", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("announces the wait politely, and only after the 300 ms blank", () => {
    render(
      <SetupCard
        state="checking"
        sizeLabel=""
        onGetReady={noop}
        onChoose={noop}
        onCancel={noop}
        onRetry={noop}
        onNotNow={noop}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Reading the setup status");
    expect(status.closest('[aria-busy="true"]')).toBeNull();
  });
});

describe("SetupCard cancel", () => {
  function Harness() {
    const [state, setState] = useState<"downloading" | "needed">("downloading");
    return (
      <SetupCard
        state={state}
        sizeLabel="about 2 GB"
        onGetReady={noop}
        onChoose={noop}
        onCancel={() => setState("needed")}
        onRetry={noop}
        onNotNow={noop}
      />
    );
  }

  it("moves focus to Get ready when the cancelled row re-renders", async () => {
    render(<Harness />);
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel the download" }),
    );
    expect(screen.getByRole("button", { name: "Get ready" })).toHaveFocus();
  });

  it("falls back to the card heading when no button is offered", async () => {
    function ToolsHarness() {
      const [state, setState] = useState<"downloading" | "tools-missing">(
        "downloading",
      );
      return (
        <SetupCard
          state={state}
          sizeLabel=""
          onGetReady={noop}
          onChoose={noop}
          onCancel={() => setState("tools-missing")}
          onRetry={noop}
          onNotNow={noop}
        />
      );
    }
    render(<ToolsHarness />);
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel the download" }),
    );
    expect(
      screen.getByRole("heading", { name: "Get ShareCut ready" }),
    ).toHaveFocus();
  });
});
