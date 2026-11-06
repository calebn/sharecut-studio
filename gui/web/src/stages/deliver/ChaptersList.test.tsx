import { fireEvent, render, screen } from "@testing-library/react";
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
    const time = screen.getAllByRole("spinbutton", { name: /^Time of/ })[0];
    await user.click(time);
    await user.keyboard("30:00{Enter}");
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

describe("ChaptersList time scrub", () => {
  const props = {
    chapters: CHAPTERS,
    total: TOTAL,
    onRetitle: vi.fn(),
    onPlayFrom: vi.fn(),
    onRemove: vi.fn(),
    onAdd: vi.fn(),
  };
  const time = () =>
    screen.getByRole("spinbutton", { name: "Time of Cold open" });
  const drag = (to: number) => {
    fireEvent.pointerDown(time(), { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(time(), { clientX: 110, pointerId: 1 });
    fireEvent.pointerMove(time(), { clientX: to, pointerId: 1 });
    fireEvent.pointerUp(time(), { pointerId: 1 });
  };

  it("snaps a drag to the nearest sentence start and retimes once", () => {
    const onRetime = vi.fn();
    render(
      <ChaptersList {...props} onRetime={onRetime} sentenceStarts={[5, 20]} />,
    );
    drag(230);
    expect(onRetime).toHaveBeenCalledTimes(1);
    expect(onRetime).toHaveBeenCalledWith("c1", 5);
  });

  it("moves freely without sentence starts", () => {
    const onRetime = vi.fn();
    render(<ChaptersList {...props} onRetime={onRetime} />);
    drag(230);
    expect(onRetime).toHaveBeenCalledWith("c1", 12);
  });

  it("shows the snapped time while the drag runs and sends nothing until it ends", () => {
    const onRetime = vi.fn();
    render(
      <ChaptersList {...props} onRetime={onRetime} sentenceStarts={[5, 20]} />,
    );
    fireEvent.pointerDown(time(), { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(time(), { clientX: 110, pointerId: 1 });
    fireEvent.pointerMove(time(), { clientX: 230, pointerId: 1 });
    expect(time()).toHaveAttribute("aria-valuetext", "5.00 s");
    expect(onRetime).not.toHaveBeenCalled();
    fireEvent.pointerUp(time(), { pointerId: 1 });
  });

  it("does not snap a typed time or an arrow step", async () => {
    const onRetime = vi.fn();
    const user = userEvent.setup();
    render(
      <ChaptersList {...props} onRetime={onRetime} sentenceStarts={[5, 20]} />,
    );
    await user.click(time());
    await user.keyboard("7.5{Enter}");
    expect(onRetime).toHaveBeenLastCalledWith("c1", 7.5);
    fireEvent.keyDown(time(), { key: "ArrowUp" });
    expect(onRetime).toHaveBeenLastCalledWith("c1", 0.1);
  });

  it("Escape in the typed field sends nothing and keeps focus on the time", async () => {
    const onRetime = vi.fn();
    const user = userEvent.setup();
    render(
      <ChaptersList {...props} onRetime={onRetime} sentenceStarts={[5]} />,
    );
    await user.click(time());
    await user.keyboard("9{Escape}");
    expect(onRetime).not.toHaveBeenCalled();
    expect(time()).toHaveFocus();
  });
});
