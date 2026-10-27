import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Player, type PlayerProps } from "./Player";

const base: PlayerProps = {
  form: "bar",
  playing: false,
  time: "12:04",
  total: "52:10",
  onPlayPause: () => undefined,
};
const chapters = [
  { title: "Cold open", time: "0:00", at: 0 },
  { title: "The long way round", time: "26:05", at: 0.5 },
];

describe("Player", () => {
  it("switches A and B as a segmented control", async () => {
    const user = userEvent.setup();
    const onHearOriginal = vi.fn();
    render(<Player {...base} onHearOriginal={onHearOriginal} />);
    expect(screen.getByRole("group", { name: "Audition" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "B" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "A" }));
    expect(onHearOriginal).toHaveBeenLastCalledWith(true);
  });

  it("leaves A/B out for a guest", () => {
    render(<Player {...base} guest />);
    expect(screen.queryByRole("button", { name: "A" })).toBeNull();
  });

  it("shows the audio error as a danger pill with Retry in both forms", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(
      <Player {...base} state="error" onRetry={onRetry} />,
    );
    expect(screen.getByText("Audio error").closest(".pill")).toHaveClass(
      "sys-pill--danger",
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    rerender(
      <Player {...base} form="expanded" state="error" onRetry={onRetry} />,
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("tells a chapter row's index, and collapses with a named icon button", async () => {
    const user = userEvent.setup();
    const onChapter = vi.fn();
    const onCollapse = vi.fn();
    render(
      <Player
        {...base}
        form="expanded"
        title="Episode 14"
        chapters={chapters}
        chapter={0}
        onChapter={onChapter}
        onCollapse={onCollapse}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /The long way round/ }),
    );
    expect(onChapter).toHaveBeenCalledWith(1);
    expect(screen.getByRole("button", { name: /Cold open/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Collapse player" }));
    expect(onCollapse).toHaveBeenCalledOnce();
  });

  it("names the skips and passes the signed seconds", async () => {
    const user = userEvent.setup();
    const onSkip = vi.fn();
    render(<Player {...base} onSkip={onSkip} />);
    await user.click(screen.getByRole("button", { name: "Back 15 seconds" }));
    await user.click(
      screen.getByRole("button", { name: "Forward 15 seconds" }),
    );
    expect(onSkip.mock.calls).toEqual([[-15], [15]]);
  });

  it("names who is followed in a pill, not by colour alone", () => {
    render(<Player {...base} following={{ name: "Rosa", colorIndex: 1 }} />);
    expect(screen.getByText("Following Rosa")).toBeInTheDocument();
  });

  it.each([
    ["bar", true],
    ["bar", false],
    ["expanded", true],
    ["expanded", false],
  ] as const)(
    "the %s form has a Comment button only with a handler: %s",
    async (form, withHandler) => {
      const user = userEvent.setup();
      const onComment = vi.fn();
      render(
        <Player
          {...base}
          form={form}
          onComment={withHandler ? onComment : undefined}
        />,
      );
      const button = screen.queryByRole("button", { name: "Comment" });
      expect(!!button).toBe(withHandler);
      if (button) {
        await user.click(button);
        expect(onComment).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    ["with a handler", true],
    ["without one", false],
  ])("Collapse player is shown %s", (_name, withHandler) => {
    render(
      <Player
        {...base}
        form="expanded"
        onCollapse={withHandler ? () => undefined : undefined}
      />,
    );
    expect(!!screen.queryByRole("button", { name: "Collapse player" })).toBe(
      withHandler,
    );
  });
});
