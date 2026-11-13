import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { SetupCard } from "./SetupCard";

const noop = () => {};

describe("SetupCard on a device without audio tools", () => {
  it("shows the server's sentence and offers nothing to do", async () => {
    const { container } = render(
      <SetupCard
        state="tools-unsupported"
        sizeLabel=""
        detail="ShareCut can't process audio on this device yet."
        onGetReady={noop}
        onChoose={noop}
        onCancel={noop}
        onRetry={noop}
        onNotNow={noop}
      />,
    );
    expect(screen.getByRole("heading", { name: "Audio tools" })).toBeVisible();
    expect(
      screen.getByText("ShareCut can't process audio on this device yet."),
    ).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    await expectNoA11yViolations(container);
  });
});

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

  it("gives up after 8 s and offers Try again", () => {
    const onRetry = vi.fn();
    render(
      <SetupCard
        state="checking"
        sizeLabel=""
        onGetReady={noop}
        onChoose={noop}
        onCancel={noop}
        onRetry={onRetry}
        onNotNow={noop}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.getByText("Couldn't check what's installed.")).toBeVisible();
    screen.getByRole("button", { name: "Try again" }).click();
    expect(onRetry).toHaveBeenCalledOnce();
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
