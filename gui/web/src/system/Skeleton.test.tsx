import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { Skeleton, SkeletonBlock } from "./Skeleton";

describe("SkeletonBlock", () => {
  it("is hidden from assistive technology and can be a circle", () => {
    const { container } = render(<SkeletonBlock circle />);
    const block = container.firstElementChild;
    expect(block).toHaveAttribute("aria-hidden", "true");
    expect(block).toHaveClass(
      "sys-skeleton-block",
      "sys-skeleton-block--circle",
    );
  });
});

describe("Skeleton Retry", () => {
  it("keeps the slow loading status without offering Retry when no handler exists", () => {
    render(<Skeleton elapsedMs={5_000} />);
    expect(screen.getByRole("status")).toHaveTextContent("Still loading…");
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });

  it.each(["{Enter}", " "])(
    "retries with %s, prevents duplicate attempts during the hold, and recovers",
    async (key) => {
      const user = userEvent.setup();
      const onRetry = vi.fn();
      render(<Skeleton elapsedMs={5_000} retryMs={400} onRetry={onRetry} />);
      const button = screen.getByRole("button", { name: "Retry" });
      await user.tab();
      expect(button).toHaveFocus();
      await user.keyboard(key);
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(button).toHaveAccessibleName("Trying…");
      expect(button).toHaveAttribute("aria-busy", "true");
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toHaveFocus();
      await user.keyboard(key);
      await user.click(button);
      expect(onRetry).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(button).toHaveAccessibleName("Retry"));
      expect(button).not.toHaveAttribute("aria-busy");
      expect(button).not.toHaveAttribute("aria-disabled");
      await user.keyboard(key);
      expect(onRetry).toHaveBeenCalledTimes(2);
    },
  );

  it.each([undefined, () => {}])(
    "has no axe violations with handler %s",
    async (onRetry) => {
      const { container } = render(
        <Skeleton elapsedMs={5_000} onRetry={onRetry} />,
      );
      await expectNoA11yViolations(container);
    },
  );

  it("keeps both labels in the DOM and hides the one not shown from assistive tech", () => {
    const { container } = render(
      <Skeleton elapsedMs={5_000} onRetry={() => {}} />,
    );
    const hidden = () =>
      Array.from(
        container.querySelectorAll(".sys-busy-label > [aria-hidden]"),
      ).map((el) => el.textContent);
    expect(screen.getByText("Retry")).toBeInTheDocument();
    expect(screen.getByText("Trying…")).toBeInTheDocument();
    expect(hidden()).toEqual(["Trying…"]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(hidden()).toEqual(["Retry"]);
    expect(screen.getByRole("button", { name: "Trying…" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });
});

describe("Skeleton guest layout with a head", () => {
  afterEach(() => vi.useRealTimers());

  it("leaves out the grey header block, puts the head first with the phase, and keeps the other blocks", () => {
    const head = vi.fn((phase: string) => <header data-head={phase} />);
    const { container } = render(
      <Skeleton layout="guest" elapsedMs={500} head={head} />,
    );
    expect(head).toHaveBeenCalledWith("blocks");
    const skeleton = container.querySelector(".sys-skeleton") as HTMLElement;
    expect(skeleton.firstElementChild).toHaveAttribute("data-head", "blocks");
    expect(container.querySelector(".sys-skeleton-block--header")).toBeNull();
    expect(
      container.querySelector(".sys-skeleton-block--player"),
    ).not.toBeNull();
  });

  it("gives the head the blank phase before 300 ms", () => {
    const { container } = render(
      <Skeleton
        layout="guest"
        elapsedMs={0}
        head={(phase) => <header data-head={phase} />}
      />,
    );
    expect(container.querySelector("[data-head]")).toHaveAttribute(
      "data-head",
      "blank",
    );
  });

  it("keeps the grey header block when no head is given", () => {
    const { container } = render(<Skeleton layout="guest" elapsedMs={500} />);
    expect(
      container.querySelector(".sys-skeleton-block--header"),
    ).not.toBeNull();
  });
});

describe("Skeleton waitedMs", () => {
  afterEach(() => vi.useRealTimers());

  it("opens in the phase the time already waited has reached, and counts the rest", () => {
    vi.useFakeTimers();
    const { container } = render(<Skeleton layout="guest" waitedMs={200} />);
    const phase = () =>
      container.querySelector(".sys-skeleton")?.getAttribute("data-phase");
    expect(phase()).toBe("blank");
    act(() => void vi.advanceTimersByTime(100));
    expect(phase()).toBe("blocks");
    act(() => void vi.advanceTimersByTime(3699));
    expect(phase()).toBe("blocks");
    act(() => void vi.advanceTimersByTime(1));
    expect(phase()).toBe("slow");
  });

  it("opens straight into blocks, or into Still loading…, when that much has passed", () => {
    const blocks = render(<Skeleton layout="guest" waitedMs={350} />);
    expect(blocks.container.querySelector(".sys-skeleton")).toHaveAttribute(
      "data-phase",
      "blocks",
    );
    blocks.unmount();
    const slow = render(<Skeleton layout="guest" waitedMs={4200} />);
    expect(slow.container.querySelector(".sys-skeleton")).toHaveAttribute(
      "data-phase",
      "slow",
    );
  });

  it("is blank on its first frame, even with a zero blank time, and shows blocks a tick later, when no time was carried in", () => {
    vi.useFakeTimers();
    const { container } = render(<Skeleton blankMs={0} />);
    const root = container.querySelector(".sys-skeleton");
    expect(root).toHaveAttribute("data-phase", "blank");
    expect(container.querySelectorAll(".sys-skeleton-block")).toHaveLength(0);
    act(() => void vi.advanceTimersByTime(0));
    expect(root).toHaveAttribute("data-phase", "blocks");
  });

  it("has no Still loading… on the first frame of a zero retry time when no time was carried in", () => {
    vi.useFakeTimers();
    const { container } = render(<Skeleton blankMs={0} retryMs={0} />);
    expect(container.querySelector(".sys-skeleton")).toHaveAttribute(
      "data-phase",
      "blank",
    );
  });
});
