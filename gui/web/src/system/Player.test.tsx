import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it.each(["bar", "expanded"] as const)(
    "shows the status line and describes a disabled Play with it in the %s form",
    (form) => {
      render(
        <Player
          {...base}
          form={form}
          status="Import audio to play."
          playUnavailable
        />,
      );
      const play = screen.getByRole("button", { name: "Play" });
      expect(play).toHaveAttribute("aria-disabled", "true");
      expect(play).toHaveAccessibleDescription("Import audio to play.");
      expect(screen.getByText("Import audio to play.")).toBeVisible();
    },
  );

  it("shows a mix status without disabling Play", () => {
    render(<Player {...base} status="Mix out of date" />);
    expect(screen.getByText("Mix out of date")).toBeVisible();
    expect(screen.getByRole("button", { name: "Play" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it.each(["bar", "expanded"] as const)(
    "leaves Comment out where no handler is given, in the %s form",
    (form) => {
      const { rerender } = render(<Player {...base} form={form} />);
      expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
      rerender(<Player {...base} form={form} onComment={() => undefined} />);
      expect(
        screen.getByRole("button", { name: "Comment" }),
      ).toBeInTheDocument();
    },
  );

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

  describe("hear original", () => {
    afterEach(() => vi.restoreAllMocks());

    const press = (button: HTMLElement) =>
      fireEvent.pointerDown(button, { button: 0 });
    const releaseAfter = (button: HTMLElement, ms: number) => {
      const start = performance.now();
      vi.spyOn(performance, "now").mockReturnValue(start + ms);
      fireEvent.pointerUp(button);
    };

    it("hears the original on press and stays on after a quick release", () => {
      const onHearOriginal = vi.fn();
      render(<Player {...base} onHearOriginal={onHearOriginal} />);
      const a = screen.getByRole("button", { name: "A" });
      press(a);
      expect(onHearOriginal).toHaveBeenLastCalledWith(true);
      releaseAfter(a, 20);
      expect(onHearOriginal).toHaveBeenCalledTimes(1);
    });

    it("goes back on release after a hold, and ignores the click that follows", () => {
      const onHearOriginal = vi.fn();
      render(<Player {...base} onHearOriginal={onHearOriginal} />);
      const a = screen.getByRole("button", { name: "A" });
      press(a);
      releaseAfter(a, 600);
      expect(onHearOriginal.mock.calls).toEqual([[true], [false]]);
      fireEvent.click(a);
      expect(onHearOriginal).toHaveBeenCalledTimes(2);
    });

    it("leaves the original on when it was already on before the hold", () => {
      const onHearOriginal = vi.fn();
      render(<Player {...base} hearOriginal onHearOriginal={onHearOriginal} />);
      const a = screen.getByRole("button", { name: "A" });
      press(a);
      releaseAfter(a, 600);
      expect(onHearOriginal).not.toHaveBeenCalled();
    });
  });

  describe("hear menu", () => {
    it("opens on right-click and picks a mode", async () => {
      const user = userEvent.setup();
      const onMode = vi.fn();
      render(<Player {...base} hearMenu={{ mode: "mix", onMode }} />);
      fireEvent.contextMenu(screen.getByRole("group", { name: "Audition" }));
      const full = await screen.findByRole("menuitemradio", {
        name: "Full mix",
      });
      expect(full).toHaveAttribute("aria-checked", "true");
      await user.click(
        screen.getByRole("menuitemradio", { name: "Without mix processing" }),
      );
      expect(onMode).toHaveBeenCalledWith("edited");
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("opens from its button too, with the three modes in plain words", async () => {
      const user = userEvent.setup();
      render(
        <Player {...base} hearMenu={{ mode: "original", onMode: vi.fn() }} />,
      );
      await user.click(screen.getByRole("button", { name: "Hear options" }));
      expect(
        screen.getAllByRole("menuitemradio").map((row) => row.textContent),
      ).toEqual(["Full mix", "Without mix processing", "Original"]);
      expect(
        screen.getByRole("menuitemradio", { name: "Original" }),
      ).toHaveAttribute("aria-checked", "true");
    });

    it("has no menu for a guest, who hears the mix only", () => {
      render(
        <Player {...base} guest hearMenu={{ mode: "mix", onMode: vi.fn() }} />,
      );
      expect(screen.queryByRole("button", { name: "Hear options" })).toBeNull();
    });
  });
});
