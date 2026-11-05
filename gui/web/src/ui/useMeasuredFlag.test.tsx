import { act, render, screen } from "@testing-library/react";
import { StrictMode, useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeResizeObserver, stubResizeObserver } from "../test/resizeObserver";
import { useMeasuredFlag } from "./useMeasuredFlag";

function Harness({
  measure,
  replacement = false,
  onAttached,
}: {
  measure: (element: HTMLDivElement) => boolean | null;
  replacement?: boolean;
  onAttached?: (element: HTMLDivElement | null) => void;
}) {
  const { attach, element, value } = useMeasuredFlag(measure);
  useLayoutEffect(() => onAttached?.(element.current), [element, onAttached]);
  return (
    <div
      key={replacement ? "b" : "a"}
      ref={attach}
      data-testid="measured"
      data-value={value}
    />
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("useMeasuredFlag", () => {
  it("samples attachment without a ResizeObserver and exposes the attached event target", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const measure = vi.fn(() => true);
    const onAttached = vi.fn();
    const { rerender } = render(
      <Harness measure={measure} onAttached={onAttached} />,
    );
    const target = screen.getByTestId("measured");
    expect(target).toHaveAttribute("data-value", "true");
    expect(onAttached).toHaveBeenCalledWith(target);
    rerender(<Harness measure={measure} onAttached={onAttached} />);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("retains an unmeasurable result and samples the next visible resize", () => {
    stubResizeObserver();
    let sample: boolean | null = true;
    const measure = () => sample;
    render(<Harness measure={measure} />);
    const target = screen.getByTestId("measured");
    const observer = FakeResizeObserver.of(target);
    sample = null;
    act(() => observer.fire());
    expect(target).toHaveAttribute("data-value", "true");
    sample = false;
    act(() => observer.fire());
    expect(target).toHaveAttribute("data-value", "false");
  });

  it("rejects a retired observer target after replacement", () => {
    stubResizeObserver();
    let sample = true;
    const measure = vi.fn(() => sample);
    const { rerender } = render(<Harness measure={measure} />);
    const oldTarget = screen.getByTestId("measured");
    const oldObserver = FakeResizeObserver.of(oldTarget);
    sample = false;
    rerender(<Harness measure={measure} replacement />);
    const target = screen.getByTestId("measured");
    expect(target).not.toBe(oldTarget);
    expect(target).toHaveAttribute("data-value", "false");
    expect(oldObserver.disconnected).toBe(true);
    sample = true;
    const calls = measure.mock.calls.length;
    act(() => oldObserver.fire(oldTarget));
    expect(measure).toHaveBeenCalledTimes(calls);
    expect(target).toHaveAttribute("data-value", "false");
    act(() => FakeResizeObserver.of(target).fire());
    expect(target).toHaveAttribute("data-value", "true");
  });

  it("keeps one live observer through StrictMode replay and disposes it on removal", () => {
    stubResizeObserver();
    const measure = () => true;
    const { unmount } = render(
      <StrictMode>
        <Harness measure={measure} />
      </StrictMode>,
    );
    expect(screen.getByTestId("measured")).toHaveAttribute(
      "data-value",
      "true",
    );
    expect(
      FakeResizeObserver.all.filter((observer) => !observer.disconnected),
    ).toHaveLength(1);
    unmount();
    expect(
      FakeResizeObserver.all.every((observer) => observer.disconnected),
    ).toBe(true);
  });
});
