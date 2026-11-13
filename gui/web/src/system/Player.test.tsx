import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { systemCss } from "../test/systemCss";
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
  it("seeks from the expanded overview strip, and not from the bar", () => {
    const onSeek = vi.fn();
    const { rerender } = render(
      <Player
        {...base}
        form="expanded"
        duration={3130}
        playhead={0.5}
        onSeek={onSeek}
      />,
    );
    fireEvent.keyDown(
      screen.getByRole("slider", { name: "Episode overview" }),
      {
        key: "End",
      },
    );
    expect(onSeek).toHaveBeenCalledWith(1);
    rerender(<Player {...base} form="bar" onSeek={onSeek} />);
    expect(screen.queryByRole("slider")).toBeNull();
  });

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
    "shows the status text in the pill and gives it a hover title, in the %s form",
    (form) => {
      render(<Player {...base} form={form} status="Mix out of date" />);
      const pill = screen
        .getByText("Mix out of date")
        .closest(".sys-player-pill") as HTMLElement;
      expect(pill).toHaveTextContent("Mix out of date");
      expect(pill).toHaveAttribute("title", "Mix out of date");
    },
  );

  it("shows the total duration under the expanded strip when the episode has one", () => {
    render(<Player {...base} form="expanded" total="52:10" duration={3130} />);
    expect(document.querySelector(".sys-player-total")).toHaveTextContent(
      "52:10",
    );
  });

  it("shows no total duration when the episode has none yet", () => {
    render(<Player {...base} form="expanded" total="00:00.000" duration={0} />);
    expect(document.querySelector(".sys-player-total")).toBeNull();
  });

  it("does not hide the total duration label on a narrow Player", () => {
    const css = systemCss();
    const hides = (sel: string) =>
      new RegExp(`(^|\\n)\\s*${sel}\\s*\\{[^}]*display:\\s*none`);
    expect(css).toMatch(hides("\\.sys-player-time \\.sys-player-total"));
    expect(css).not.toMatch(hides("\\.sys-player-total"));
    expect(css).not.toMatch(
      hides("\\.sys-player-expanded[^{,]*\\.sys-player-total"),
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

  it("rings Play in the followed person's colour and leaves the naming to the header pill", () => {
    const { container } = render(
      <Player {...base} following={{ name: "Rosa", colorIndex: 1 }} />,
    );
    expect(container.querySelector(".sys-play")).toHaveAttribute(
      "data-following",
    );
    expect(screen.queryByText("Following Rosa")).toBeNull();
  });

  it("explains a partial follow in the pill tooltip and a status for screen readers", () => {
    render(
      <Player
        {...base}
        following={{
          name: "Rosa",
          colorIndex: 1,
          detail: "in Pipeline (host-only) · auditioning FX",
        }}
      />,
    );
    const pill = screen.getByText("Following Rosa").closest(".sys-player-pill");
    expect(pill).toHaveAttribute(
      "title",
      "Following Rosa · in Pipeline (host-only) · auditioning FX",
    );
    expect(document.querySelector("[data-follow-detail]")).toHaveTextContent(
      "in Pipeline (host-only) · auditioning FX",
    );
    expect(pill).toHaveTextContent(
      "· in Pipeline (host-only) · auditioning FX",
    );
  });

  it("keeps one status region mounted so a detail that appears is announced", () => {
    const { rerender } = render(
      <Player {...base} following={{ name: "Rosa", colorIndex: 1 }} />,
    );
    const region = document.querySelector("[data-follow-detail]");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent("");
    rerender(
      <Player
        {...base}
        following={{ name: "Rosa", colorIndex: 1, detail: "auditioning FX" }}
      />,
    );
    expect(document.querySelector("[data-follow-detail]")).toBe(region);
    expect(region).toHaveTextContent("auditioning FX");
  });

  it("adds no status role to a Player that is not following", () => {
    render(<Player {...base} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows no pill when the follow is complete", () => {
    const { container } = render(
      <Player {...base} following={{ name: "Rosa", colorIndex: 1 }} />,
    );
    expect(container.querySelector(".sys-player-pill")).toBeNull();
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

  describe("dock form", () => {
    const dock = {
      ...base,
      form: "dock" as const,
      time: "1:26",
      total: "52:10",
    };

    it("shows the scrubber, readout and transport with no expand control", () => {
      render(
        <Player
          {...dock}
          duration={3130}
          playhead={0.5}
          onSeek={vi.fn()}
          onComment={vi.fn()}
        />,
      );
      expect(
        screen.getByRole("slider", { name: "Episode overview" }),
      ).toBeVisible();
      expect(screen.getByText("1:26")).toBeVisible();
      expect(screen.getByText("52:10")).toBeVisible();
      for (const name of [
        "Back 15 seconds",
        "Play",
        "Forward 15 seconds",
        "Comment at 1:26",
      ])
        expect(screen.getByRole("button", { name })).toBeVisible();
      expect(
        screen.queryByRole("button", { name: /Expand player/ }),
      ).toBeNull();
      expect(screen.getByText("Comment")).toBeVisible();
    });

    it("is a labelled region, so a screen reader can jump to it", () => {
      render(<Player {...dock} />);
      expect(screen.getByRole("region", { name: "Player" })).toBeVisible();
    });

    it("has no Comment button without a handler", () => {
      render(<Player {...dock} />);
      expect(screen.queryByRole("button", { name: /^Comment/ })).toBeNull();
    });

    it("shows the mix status as visible text, and the chapter when the mix is fine", () => {
      const { rerender } = render(
        <Player
          {...dock}
          status="Mix out of date"
          chapters={chapters}
          chapter={1}
        />,
      );
      expect(screen.getByText("Mix out of date")).toBeVisible();
      expect(screen.queryByText("The long way round")).toBeNull();
      rerender(<Player {...dock} chapters={chapters} chapter={1} />);
      expect(screen.getByText("The long way round")).toBeVisible();
    });

    it("offers Chapters only with a handler, and runs it", async () => {
      const onChapters = vi.fn();
      const { rerender } = render(<Player {...dock} />);
      expect(screen.queryByRole("button", { name: "Chapters" })).toBeNull();
      rerender(<Player {...dock} onChapters={onChapters} />);
      await userEvent.click(screen.getByRole("button", { name: "Chapters" }));
      expect(onChapters).toHaveBeenCalledTimes(1);
    });

    it("keeps a status button that explains the status", async () => {
      const onStatusInfo = vi.fn();
      render(
        <Player {...dock} status="No mix yet" onStatusInfo={onStatusInfo} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "No mix yet" }));
      expect(onStatusInfo).toHaveBeenCalledTimes(1);
    });
  });
});
