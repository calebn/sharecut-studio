import { act, render, screen } from "@testing-library/react";
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
    expect(screen.getByRole("status")).toHaveTextContent(
      "Reading the setup status",
    );
  });
});
