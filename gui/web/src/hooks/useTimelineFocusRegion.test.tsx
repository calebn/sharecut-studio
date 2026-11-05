import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useTimelineFocusRegion } from "./useTimelineFocusRegion";

it("uses the latest focus value and setter, and detaches a replaced region", () => {
  const first = vi.fn();
  const next = vi.fn();
  function Region({
    focused,
    set,
    region,
  }: {
    focused: boolean;
    set: (value: boolean) => void;
    region: string;
  }) {
    const ref = useTimelineFocusRegion<HTMLButtonElement>(focused, set);
    return (
      <button key={region} type="button" ref={ref}>
        Region
      </button>
    );
  }
  const view = render(<Region focused set={first} region="a" />);
  const old = screen.getByRole("button");
  fireEvent.mouseDown(old);
  expect(first).toHaveBeenCalledExactlyOnceWith(true);
  view.rerender(<Region focused={false} set={next} region="a" />);
  expect(screen.getByRole("button")).toBe(old);
  fireEvent.focusIn(old);
  expect(next).toHaveBeenCalledExactlyOnceWith(false);
  view.rerender(<Region focused set={next} region="b" />);
  fireEvent.mouseDown(old);
  expect(next).toHaveBeenCalledTimes(1);
  fireEvent.mouseDown(screen.getByRole("button"));
  expect(next).toHaveBeenLastCalledWith(true);
  expect(first).toHaveBeenCalledTimes(1);
});
