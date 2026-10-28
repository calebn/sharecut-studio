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
    expect(scroll).toHaveBeenCalledWith({ block: "center" });
    expect(
      screen.queryByRole("button", { name: /Back to playhead/ }),
    ).toBeNull();
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
