import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { reviewContent } from "../storybook/reviewContent";
import { QUEUE_WITHOUT_CHECKS } from "../storybook/reviewFixtures";
import { ReviewQueue } from "./ReviewQueue";

describe("ReviewQueue", () => {
  it("gives a blocked row no swipe verb", () => {
    const onVerb = vi.fn();
    const items = QUEUE_WITHOUT_CHECKS.map((i) =>
      i.id === "f1" ? { ...i, blocked: true } : i,
    );
    const { container } = render(
      <ReviewQueue
        items={items}
        content={reviewContent}
        selectedId={null}
        filter="all"
        onFilter={vi.fn()}
        onSelect={vi.fn()}
        onVerb={onVerb}
      />,
    );
    for (const row of container.querySelectorAll(".sys-queue-row")) {
      const at = (clientX: number) => ({ clientX, clientY: 0, pointerId: 1 });
      fireEvent.pointerDown(row, { ...at(100), isPrimary: true });
      fireEvent.pointerMove(row, at(190));
      fireEvent.pointerUp(row, at(190));
    }
    expect(onVerb).toHaveBeenCalled();
    expect(onVerb).not.toHaveBeenCalledWith("f1");
  });

  const renderItems = (items: typeof QUEUE_WITHOUT_CHECKS) =>
    render(
      <ReviewQueue
        items={items}
        content={reviewContent}
        selectedId={null}
        filter="all"
        onFilter={vi.fn()}
        onSelect={vi.fn()}
        onVerb={vi.fn()}
      />,
    );
  const fillers = QUEUE_WITHOUT_CHECKS.filter(
    (i) => i.kind === "filler" && !i.result,
  );

  it("names a one-item group button apart from the item Cut", () => {
    const { container } = renderItems(fillers.slice(0, 1));
    const bulk = container.querySelector(".rv-bulk");
    expect(bulk?.textContent?.trim()).toBe("Cut");
    expect(bulk?.getAttribute("aria-label")).toBe("Cut this one");
  });

  it("says how many stay for one-by-one when nothing can be cut together", () => {
    const { container, getByText } = renderItems(
      fillers.map((i) => ({ ...i, oneByOne: true })),
    );
    expect(container.querySelector(".rv-bulk")).toBeNull();
    expect(
      getByText(`${fillers.length} to decide one by one`),
    ).toBeInTheDocument();
  });

  it("keeps the one-by-one line from a guest, who decides nothing", () => {
    const { queryByText } = render(
      <ReviewQueue
        items={fillers.map((i) => ({ ...i, oneByOne: true }))}
        content={reviewContent}
        selectedId={null}
        filter="all"
        guest
        onFilter={vi.fn()}
        onSelect={vi.fn()}
        onVerb={vi.fn()}
      />,
    );
    expect(queryByText(/to decide one by one/)).toBeNull();
  });

  it("shows the bulk row for a group that has left the queue, without a fake bar", () => {
    const { getByText, queryByRole, queryByText } = render(
      <ReviewQueue
        items={[]}
        content={reviewContent}
        selectedId={null}
        filter="all"
        bulkRunning={{
          kind: "filler",
          total: 11,
          startedAtSec: Date.now() / 1000 - 5,
        }}
        onFilter={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(getByText("Cutting 11…")).toBeInTheDocument();
    expect(getByText("0:05 so far")).toBeInTheDocument();
    expect(queryByRole("progressbar")).toBeNull();
    expect(queryByText("Nothing to decide")).toBeNull();
  });

  it("keeps the count and bar in the group header when the host reports done", () => {
    const { getByText, getByRole, queryByRole } = render(
      <ReviewQueue
        items={fillers}
        content={reviewContent}
        selectedId={null}
        filter="all"
        bulkRunning={{ kind: "filler", total: 4, done: 1 }}
        onFilter={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(getByText("1 done")).toBeInTheDocument();
    expect(getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(queryByRole("button", { name: /^Cut all/ })).toBeNull();
  });

  it("shows a job error with Try again, and a job without a percent", () => {
    const onFindMore = vi.fn();
    const props = {
      items: [],
      content: reviewContent,
      selectedId: null,
      filter: "all" as const,
      onFilter: vi.fn(),
      onSelect: vi.fn(),
      onFindMore,
    };
    const { getByRole, getByText, rerender, queryByText } = render(
      <ReviewQueue {...props} job={{ title: "Finding suggestions" }} />,
    );
    expect(getByText("Finding suggestions")).toBeInTheDocument();
    expect(queryByText(/%/)).toBeNull();
    rerender(<ReviewQueue {...props} job={{ title: "", error: "Crashed." }} />);
    fireEvent.click(getByRole("button", { name: "Try again" }));
    expect(onFindMore).toHaveBeenCalledOnce();
  });

  it("keeps the standalone Cutting row out of a filter that does not hold its kind", () => {
    const props = {
      items: [],
      content: reviewContent,
      selectedId: null,
      onFilter: vi.fn(),
      onSelect: vi.fn(),
      bulkRunning: { kind: "filler" as const, total: 4 },
    };
    const { queryByText, rerender } = render(
      <ReviewQueue {...props} filter="comments" />,
    );
    expect(queryByText("Cutting 4…")).toBeNull();
    rerender(<ReviewQueue {...props} filter="suggestions" />);
    expect(queryByText("Cutting 4…")).not.toBeNull();
  });

  it("describes the disabled Find more by a visible note", () => {
    const { getByRole, getByText } = render(
      <ReviewQueue
        items={[]}
        content={reviewContent}
        selectedId={null}
        filter="all"
        findMoreDisabled="Wait for the settings to load."
        onFilter={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(getByRole("button", { name: "Find more" })).toHaveAttribute(
      "aria-describedby",
      getByText("Wait for the settings to load.").id,
    );
  });
});
