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
    const { rerender } = render(
      <Player {...base} onHearOriginal={onHearOriginal} />,
    );
    const pressed = () =>
      ["A", "B"].map((name) =>
        screen.getByRole("button", { name }).getAttribute("aria-pressed"),
      );
    expect(screen.getByRole("group", { name: "Audition" })).toBeInTheDocument();
    expect(pressed()).toEqual(["false", "true"]);
    await user.click(screen.getByRole("button", { name: "A" }));
    expect(onHearOriginal).toHaveBeenLastCalledWith(true);
    rerender(<Player {...base} hearOriginal onHearOriginal={onHearOriginal} />);
    expect(pressed()).toEqual(["true", "false"]);
    await user.click(screen.getByRole("button", { name: "B" }));
    expect(onHearOriginal).toHaveBeenLastCalledWith(false);
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
    expect(
      screen.getByRole("button", { name: /The long way round/ }),
    ).not.toHaveAttribute("aria-current");
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

  it.each(["bar", "expanded"] as const)(
    "the %s form has a Comment button that fires with a handler",
    async (form) => {
      const user = userEvent.setup();
      const onComment = vi.fn();
      render(<Player {...base} form={form} onComment={onComment} />);
      await user.click(screen.getByRole("button", { name: "Comment" }));
      expect(onComment).toHaveBeenCalledOnce();
    },
  );

  it.each(["bar", "expanded"] as const)(
    "the %s form has no Comment button without a handler",
    (form) => {
      render(<Player {...base} form={form} />);
      expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    },
  );

  it("shows Collapse player with a handler", () => {
    render(<Player {...base} form="expanded" onCollapse={() => undefined} />);
    expect(
      screen.getByRole("button", { name: "Collapse player" }),
    ).toBeInTheDocument();
  });

  it("shows no Collapse player without a handler", () => {
    render(<Player {...base} form="expanded" />);
    expect(
      screen.queryByRole("button", { name: "Collapse player" }),
    ).toBeNull();
  });
});
