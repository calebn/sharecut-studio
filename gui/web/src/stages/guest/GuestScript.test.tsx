import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCRIPT_TURNS } from "../../system/scriptFixtures";
import { NEAREST, probeScript } from "../../system/scriptScrollProbe";
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

describe("GuestScript following", () => {
  let probe: ReturnType<typeof probeScript> | undefined;
  afterEach(() => probe?.restore());
  const textOf = (index: number) =>
    SCRIPT_TURNS.flatMap((turn) => turn.words).find((w) => w.index === index)
      ?.text;
  const view = (props: Partial<GuestScriptProps> = {}) => {
    const rendered = (extra: Partial<GuestScriptProps>) => (
      <GuestScript
        access="commenter"
        layout="desktop"
        turns={SCRIPT_TURNS}
        wordStarts={WORD_STARTS}
        playing={1}
        onSeek={vi.fn()}
        {...props}
        {...extra}
      />
    );
    const { rerender } = render(rendered({}));
    const body = document.querySelector(".sys-script-body") as HTMLElement;
    probe = probeScript(body);
    return {
      body,
      rerender: (extra: Partial<GuestScriptProps>) => rerender(rendered(extra)),
    };
  };
  const scrollAway = (body: HTMLElement) => {
    fireEvent.wheel(body);
    fireEvent.scroll(body);
  };

  it("follows the lowest-indexed word when two overlapping words play", () => {
    expect(textOf(1)).not.toBe(textOf(3));
    const { rerender } = view({ playing: undefined });
    probe?.clear();
    rerender({ playing: [1, 3] });
    expect(probe?.calls).toEqual([[textOf(1), NEAREST]]);
  });

  it("follows a lone playing number the same way", () => {
    const { rerender } = view({ playing: undefined });
    probe?.clear();
    rerender({ playing: 3 });
    expect(probe?.calls).toEqual([[textOf(3), NEAREST]]);
  });

  it("follows the playhead word when nothing is playing", () => {
    const { rerender } = view({ playing: undefined });
    probe?.clear();
    rerender({ playing: undefined, playheadWord: 3 });
    expect(probe?.calls).toEqual([[textOf(3), NEAREST]]);
  });

  it("neither scrolls to word 0 nor offers Back to playhead before the first word", () => {
    const { rerender, body } = view();
    probe?.clear();
    rerender({ playing: undefined, playheadWord: undefined });
    expect(probe?.calls).toEqual([]);
    scrollAway(body);
    expect(
      screen.queryByRole("button", { name: /Back to playhead/ }),
    ).toBeNull();
  });

  it("scrolls to the playing word when Follow is switched back on, playhead unchanged", async () => {
    const { body } = view();
    scrollAway(body);
    const toggle = screen.getByRole("button", { name: "Follow the playhead" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    probe?.clear();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(probe?.calls).toEqual([[textOf(1), NEAREST]]);
  });

  it("tells its host when the guest scrolls the Script themselves", () => {
    const onUserScroll = vi.fn();
    const { body } = view({ onUserScroll });
    fireEvent.scroll(body);
    expect(onUserScroll).not.toHaveBeenCalled();
    scrollAway(body);
    expect(onUserScroll).toHaveBeenCalledOnce();
  });

  it("says the words are not on the timeline when they exist but have no place", () => {
    render(
      <GuestScript
        access="viewer"
        layout="desktop"
        turns={[]}
        wordStarts={[]}
        playing={undefined}
        hasTranscript
        unplaced={3}
        onSeek={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "The words of this version are not on the timeline yet.",
      ),
    ).toBeInTheDocument();
  });
});
