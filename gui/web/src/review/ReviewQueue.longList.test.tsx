import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReviewStageHarness } from "../storybook/reviewHarness";
import { formatTimeShort } from "../utils/time";
import type { ReviewContent } from "./ReviewQueue";
import type { ReviewItem } from "./reviewQueueModel";

const unsureWords: readonly ReviewItem[] = Array.from(
  { length: 159 },
  (_, index) => {
    const ordinal = String(index + 1).padStart(3, "0");
    return {
      id: `unsure-${ordinal}`,
      kind: "unsure-word",
      at: index * 4,
      savedSeconds: 0,
    };
  },
);

const comment: ReviewItem = {
  id: "comment-boat",
  kind: "comment",
  at: 700,
  savedSeconds: 0,
};

const items = [...unsureWords, comment];

function content(item: ReviewItem): ReviewContent {
  if (item.kind === "comment") {
    return {
      row: { snippet: "Keep the laugh by the boat?", time: "11:40" },
      card: {
        title: "Rosa asks about the laugh",
        time: "11:40",
        comment: {
          author: { name: "Rosa" },
          time: "11:40",
          body: "Keep the laugh by the boat?",
        },
      },
    };
  }

  const ordinal = item.id.slice("unsure-".length);
  const word = `unclear-word-${ordinal}`;
  const time = formatTimeShort(item.at);
  return {
    row: { snippet: word, time },
    card: {
      title: `Check “${word}”`,
      time,
      unsure: { word, guess: word, id: item.id },
    },
  };
}

describe("ReviewQueue long list", () => {
  it("keeps 159 unsure words and a comment independently selectable across Comments and Checks", async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    render(
      <ReviewStageHarness
        initialItems={items}
        initialSelectedId="unsure-001"
        content={content}
        duration={1000}
        onDecide={onDecide}
      />,
    );

    expect(screen.getByText("0 of 160 decided · saves 0.0 s")).toBeVisible();
    const filterGroup = screen.getByRole("group", { name: "Filter" });
    expect(within(filterGroup).getByText("Comments")).toBeVisible();
    expect(within(filterGroup).getByText("Checks")).toBeVisible();
    expect(
      within(filterGroup).getByRole("button", { name: "Comments, 1" }),
    ).toHaveTextContent("Comments 1");
    expect(
      screen
        .getByRole("region", { name: "Unsure words" })
        .querySelectorAll(".sys-queue-row"),
    ).toHaveLength(159);
    expect(screen.getByText("unclear-word-001")).toBeVisible();
    expect(screen.getByText("unclear-word-159")).toBeVisible();
    const originalWordRows = within(
      screen.getByRole("region", { name: "Unsure words" }),
    )
      .getAllByText(/^unclear-word-\d{3}$/)
      .map((row) => row.textContent);
    expect(new Set(originalWordRows).size).toBe(159);
    expect(
      screen.queryByRole("button", {
        name: /\ball \d+\b|\bthis one\b|\bclean edits?\b/i,
      }),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "Fix text" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onDecide).toHaveBeenCalledOnce();
    expect(onDecide).toHaveBeenCalledWith({
      ids: ["unsure-001"],
      result: "applied",
      text: "unclear-word-001",
    });
    expect(screen.getByText("1 of 160 decided · saves 0.0 s")).toBeVisible();

    const allFilter = screen.getByRole("button", { name: /^All,/ });
    allFilter.focus();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: /^Comments,/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: /^Comments,/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByRole("region", { name: "Unsure words" })).toBeNull();
    const commentsGroup = screen.getByRole("region", { name: "Comments" });
    expect(
      within(commentsGroup).getByText("Keep the laugh by the boat?"),
    ).toBeVisible();
    await user.click(
      within(commentsGroup).getByRole("button", {
        name: /Keep the laugh by the boat\?/,
      }),
    );

    const checksFilter = screen.getByRole("button", { name: /^Checks,/ });
    checksFilter.focus();
    await user.keyboard(" ");
    expect(checksFilter).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("region", { name: "Comments" })).toBeNull();
    const checksGroup = screen.getByRole("region", { name: "Unsure words" });
    expect(checksGroup.querySelectorAll(".sys-queue-row")).toHaveLength(158);
    expect(
      within(checksGroup)
        .getAllByText(/^unclear-word-\d{3}$/)
        .map((row) => row.textContent),
    ).toEqual(originalWordRows.slice(1));
    expect(within(checksGroup).getByText("unclear-word-002")).toBeVisible();
    expect(within(checksGroup).getByText("unclear-word-159")).toBeVisible();
    expect(within(checksGroup).queryByText("unclear-word-001")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: /\ball \d+\b|\bthis one\b|\bclean edits?\b/i,
      }),
    ).toBeNull();

    const commentsFilter = screen.getByRole("button", {
      name: /^Comments,/,
    });
    commentsFilter.focus();
    await user.keyboard("{Enter}");
    const returnedComment = screen.getByRole("button", {
      name: /Keep the laugh by the boat\?/,
    });
    expect(returnedComment).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("1 of 160 decided · saves 0.0 s")).toBeVisible();
    expect(onDecide).toHaveBeenCalledOnce();
  });
});
