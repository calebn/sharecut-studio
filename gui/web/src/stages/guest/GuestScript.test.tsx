import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SCRIPT_TURNS } from "../../system/scriptFixtures";
import { GuestScript, type GuestScriptProps } from "./GuestScript";
import { WORD_STARTS } from "./guestFixture";

function setup(props: Partial<GuestScriptProps> = {}) {
  const onSeek = vi.fn();
  render(
    <GuestScript
      access="commenter"
      layout="desktop"
      turns={SCRIPT_TURNS}
      wordStarts={WORD_STARTS}
      playing={2}
      onSeek={onSeek}
      {...props}
    />,
  );
  return { onSeek };
}

describe("GuestScript", () => {
  it("labels a viewer and a commenter differently", () => {
    const { unmount } = render(
      <GuestScript
        access="viewer"
        layout="desktop"
        turns={SCRIPT_TURNS}
        wordStarts={WORD_STARTS}
        playing={undefined}
        onSeek={vi.fn()}
      />,
    );
    expect(screen.getByText("Read only")).toBeInTheDocument();
    unmount();
    setup();
    expect(screen.getByText("Read only · you can comment")).toBeInTheDocument();
  });

  it("marks the playing words", () => {
    setup({ playing: [1, 3] });
    expect(document.querySelectorAll("[data-playing]")).toHaveLength(2);
  });

  it("seeks to the start of the clicked word", async () => {
    const { onSeek } = setup();
    const first = SCRIPT_TURNS[0]?.words[1];
    await userEvent.click(
      screen.getByRole("button", { name: first?.text as string }),
    );
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(WORD_STARTS[1]);
  });

  it("stops following on scroll, and Back to playhead scrolls to the word and follows again", async () => {
    const scroll = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scroll;
    setup();
    const body = document.querySelector(".sys-script-body") as HTMLElement;
    expect(
      screen.queryByRole("button", { name: /Back to playhead/ }),
    ).toBeNull();
    fireEvent.wheel(body);
    fireEvent.scroll(body);
    scroll.mockClear();
    await userEvent.click(
      screen.getByRole("button", { name: /Back to playhead/ }),
    );
    expect(scroll).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /Back to playhead/ }),
    ).toBeNull();
  });

  it("follows by scrolling only the Script body, never an ancestor", () => {
    const scroll = vi.fn();
    const saved = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollIntoView",
    );
    Element.prototype.scrollIntoView = scroll;
    const html = window.HTMLElement.prototype as { scrollIntoView?: unknown };
    html.scrollIntoView = scroll;
    const rect = (top: number, height: number) =>
      ({ top, height, bottom: top + height }) as DOMRect;
    const rectSpy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this.classList.contains("sys-script-body")) return rect(100, 200);
        return this.getAttribute("data-playing") !== null
          ? rect(position, 20)
          : rect(0, 0);
      });
    let position = 400;
    try {
      const view = render(
        <GuestScript
          access="commenter"
          layout="desktop"
          turns={SCRIPT_TURNS}
          wordStarts={WORD_STARTS}
          playing={1}
          onSeek={vi.fn()}
        />,
      );
      const body = document.querySelector(".sys-script-body") as HTMLElement;
      Object.defineProperty(body, "clientHeight", {
        configurable: true,
        value: 200,
      });
      // Below the view: word bottom 420-100+0 = 320 > 200, so scroll to 120.
      body.scrollTop = 0;
      view.rerender(
        <GuestScript
          access="commenter"
          layout="desktop"
          turns={SCRIPT_TURNS}
          wordStarts={WORD_STARTS}
          playing={2}
          onSeek={vi.fn()}
        />,
      );
      expect(body.scrollTop).toBe(120);
      // Above the view: word top 50-100+500 = 450 < 500, so scroll to 450.
      position = 50;
      body.scrollTop = 500;
      view.rerender(
        <GuestScript
          access="commenter"
          layout="desktop"
          turns={SCRIPT_TURNS}
          wordStarts={WORD_STARTS}
          playing={3}
          onSeek={vi.fn()}
        />,
      );
      expect(body.scrollTop).toBe(450);
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      if (saved)
        Object.defineProperty(Element.prototype, "scrollIntoView", saved);
      else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      Reflect.deleteProperty(html, "scrollIntoView");
      rectSpy.mockRestore();
    }
  });

  it("tells a guest when every word is cut, and when there is no transcript", () => {
    const { unmount } = render(
      <GuestScript
        access="viewer"
        layout="desktop"
        turns={[]}
        wordStarts={[]}
        playing={undefined}
        hasTranscript
        onSeek={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Every word of this version has been cut or ignored."),
    ).toBeInTheDocument();
    unmount();
    setup({ turns: [], wordStarts: [] });
    expect(
      screen.getByText("The host has not made a transcript of this version."),
    ).toBeInTheDocument();
  });
});
