import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChaptersList } from "./ChaptersList";
import { CHAPTERS, TOTAL } from "./deliverFixture";
import { type Chapter, retimeChapter, retitleChapter } from "./deliverLogic";

function setup(accept: boolean) {
  const onRetitle = vi.fn();
  function Host() {
    const [chapters, setChapters] = useState<readonly Chapter[]>(CHAPTERS);
    return (
      <ChaptersList
        chapters={chapters}
        total={TOTAL}
        onRetitle={(id, title) => {
          onRetitle(id, title);
          if (accept) setChapters(retitleChapter(chapters, id, title));
        }}
        onRetime={(id, at) => setChapters(retimeChapter(chapters, id, at))}
        onPlayFrom={vi.fn()}
        onRemove={vi.fn()}
        onAdd={vi.fn()}
      />
    );
  }
  render(<Host />);
  return { onRetitle, user: userEvent.setup() };
}

const first = () => screen.getAllByRole("textbox", { name: /^Title of/ })[0];

describe("ChaptersList title edit", () => {
  it("Escape puts the old title back, sends nothing and keeps focus", async () => {
    const { user, onRetitle } = setup(true);
    const was = (first() as HTMLInputElement).value;
    await user.click(first());
    await user.keyboard("zzz{Escape}");
    expect(first()).toHaveValue(was);
    expect(first()).toHaveFocus();
    await user.tab();
    expect(onRetitle).not.toHaveBeenCalled();
  });

  it("Enter commits once and the blur after it sends nothing more", async () => {
    const { user, onRetitle } = setup(true);
    await user.click(first());
    await user.keyboard("{End} two{Enter}");
    await user.tab();
    expect(onRetitle).toHaveBeenCalledTimes(1);
  });

  it("sends a title the parent rejected again on the next blur", async () => {
    const { user, onRetitle } = setup(false);
    await user.click(first());
    await user.keyboard("{End} two");
    await user.tab();
    await user.click(first());
    await user.tab();
    expect(onRetitle).toHaveBeenCalledTimes(2);
    expect(onRetitle.mock.calls[1][1]).toBe(onRetitle.mock.calls[0][1]);
  });

  it("commits a title being typed when another chapter is retimed past it, with no remount", async () => {
    const { user, onRetitle } = setup(true);
    const [a, b] = screen.getAllByRole("textbox", { name: /^Title of/ });
    expect(a).toBeDefined();
    await user.click(b);
    await user.keyboard(" draft");
    const time = screen.getAllByRole("textbox", { name: /^Time of/ })[0];
    await user.click(time);
    await user.keyboard("{Control>}a{/Control}30:00{Enter}");
    expect(onRetitle).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getAllByRole("textbox", { name: /^Title of/ })
        .some((el) => (el as HTMLInputElement).value.endsWith(" draft")),
    ).toBe(true);
  });
});

describe("ChaptersList external title change", () => {
  it("shows a title changed from outside while the row stays mounted", () => {
    const props = {
      total: TOTAL,
      onRetitle: vi.fn(),
      onRetime: vi.fn(),
      onPlayFrom: vi.fn(),
      onRemove: vi.fn(),
      onAdd: vi.fn(),
    };
    const { rerender } = render(
      <ChaptersList chapters={CHAPTERS} {...props} />,
    );
    const renamed = CHAPTERS.map((c, i) =>
      i === 0 ? { ...c, title: "Renamed elsewhere" } : c,
    );
    rerender(<ChaptersList chapters={renamed} {...props} />);
    expect(first()).toHaveValue("Renamed elsewhere");
    expect(props.onRetitle).not.toHaveBeenCalled();
  });
});
