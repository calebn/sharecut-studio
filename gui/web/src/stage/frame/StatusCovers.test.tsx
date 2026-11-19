import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestLoadFailure } from "../../guestLoadFailure";
import type { UnsentText } from "../../state/unsentText";
import { HELD_BUSY_MS } from "../../system/useHeldBusy";
import { expectNoA11yViolations } from "../../test/a11y";
import { GuestPageCover, NotServedCover } from "./StatusCovers";

describe("NotServedCover", () => {
  it("says the episode is not open here, with the spec's two ways forward", async () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <NotServedCover
        notServed={{
          name: "Rosa and Maya",
          openHref: "/?project=%2Fep.sharecut&session_token=t",
          homeHref: "/?home=1&session_token=t",
        }}
        onNavigate={onNavigate}
      />,
    );
    expect(
      screen.getByRole("heading", {
        name: "This episode isn't open on this computer",
      }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Open Rosa and Maya" }),
    );
    expect(onNavigate).toHaveBeenLastCalledWith(
      "/?project=%2Fep.sharecut&session_token=t",
    );
    await userEvent.click(screen.getByRole("button", { name: "All projects" }));
    expect(onNavigate).toHaveBeenLastCalledWith("/?home=1&session_token=t");
    await expectNoA11yViolations(container);
  });
});

describe("GuestPageCover", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function renderCover(
    failure: GuestLoadFailure,
    { trying = false, onRetry = vi.fn() } = {},
  ) {
    const view = render(
      <GuestPageCover failure={failure} trying={trying} onRetry={onRetry} />,
    );
    return {
      ...view,
      onRetry,
      again: (next: Partial<{ failure: GuestLoadFailure; trying: boolean }>) =>
        view.rerender(
          <GuestPageCover
            failure={next.failure ?? failure}
            trying={next.trying ?? trying}
            onRetry={onRetry}
          />,
        ),
    };
  }

  it("is the page's main with an h1 title and no tabindex", () => {
    renderCover({ kind: "unreachable" });
    const main = screen.getByRole("main");
    expect(main).not.toHaveAttribute("tabindex");
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "The host's computer is asleep",
      }),
    ).toBeInTheDocument();
  });

  it("moves focus to the title when it arrives", () => {
    renderCover({ kind: "server" });
    expect(
      screen.getByRole("heading", { name: "This link did not load" }),
    ).toHaveFocus();
  });

  it("keeps the button mounted and focused while a press is busy, and says each step", () => {
    const { again, onRetry } = renderCover({ kind: "unreachable" });
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("");
    const button = screen.getByRole("button", { name: "Try now" });
    button.focus();
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledOnce();
    again({ trying: true });
    expect(screen.getByRole("button", { name: "Trying…" })).toBe(button);
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveFocus();
    expect(status).toHaveTextContent("Trying again…");

    again({ trying: false });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Trying again…");
    act(() => void vi.advanceTimersByTime(600));
    expect(screen.getByRole("button", { name: "Try now" })).toBe(button);
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button).toHaveFocus();
    expect(status).toHaveTextContent("Still asleep.");
  });

  it("says Still not loading. for any other failure", () => {
    const { again } = renderCover({ kind: "server" });
    const button = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(button);
    again({ trying: true });
    expect(screen.getByRole("status")).toHaveTextContent("Trying again…");
    again({ trying: false });
    act(() => void vi.advanceTimersByTime(600));
    expect(screen.getByRole("status")).toHaveTextContent("Still not loading.");
  });

  it("shows no busy state and no status for an attempt nobody pressed", () => {
    const { again } = renderCover({ kind: "unreachable" });
    again({ trying: true });
    const button = screen.getByRole("button", { name: "Try now" });
    expect(button).not.toHaveAttribute("aria-busy");
    expect(screen.getByRole("status")).toHaveTextContent("");
    again({ trying: false });
    act(() => void vi.advanceTimersByTime(5_000));
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("empties the status when an attempt nobody pressed starts, and keeps it empty", () => {
    const { again } = renderCover({ kind: "unreachable" });
    fireEvent.click(screen.getByRole("button", { name: "Try now" }));
    again({ trying: true });
    again({ trying: false });
    act(() => void vi.advanceTimersByTime(600));
    expect(screen.getByRole("status")).toHaveTextContent("Still asleep.");
    again({ trying: true });
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(screen.getByRole("button", { name: "Try now" })).not.toHaveAttribute(
      "aria-busy",
    );
    again({ trying: false });
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("puts the status in the cover's actions, not in its body", () => {
    renderCover({ kind: "unreachable" });
    expect(
      screen.getByRole("status").closest(".sys-cover-actions"),
    ).not.toBeNull();
    expect(screen.getByRole("status").closest(".sys-cover-body")).toBeNull();
  });

  it("tells a guest whose device has no connection so, in the cover's own words", async () => {
    const { container } = renderCover({ kind: "offline" });
    const title = screen.getByRole("heading", {
      level: 1,
      name: "You're offline",
    });
    expect(title).toHaveFocus();
    expect(screen.getByRole("main")).toHaveTextContent(
      "This page opens the episode by itself when your connection is back.",
    );
    expect(container.querySelector("svg.lucide-cloud-off")).not.toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Try now" })).toBeInTheDocument();
    expect(screen.getByRole("main")).not.toHaveTextContent(/asleep|host/i);
    vi.useRealTimers();
    await expectNoA11yViolations(container);
  });

  it("answers a press on the offline cover with Trying again… and then Still offline.", () => {
    const { again, onRetry } = renderCover({ kind: "offline" });
    const button = screen.getByRole("button", { name: "Try now" });
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledOnce();
    again({ trying: true });
    expect(screen.getByRole("status")).toHaveTextContent("Trying again…");
    again({ trying: false });
    act(() => void vi.advanceTimersByTime(600));
    expect(screen.getByRole("status")).toHaveTextContent("Still offline.");
  });

  it("moves focus to the title when the cover swaps between asleep and offline, and leaves a focused button alone", () => {
    const { again } = renderCover({ kind: "unreachable" });
    again({ failure: { kind: "offline" } });
    expect(
      screen.getByRole("heading", { name: "You're offline" }),
    ).toHaveFocus();
    again({ failure: { kind: "unreachable" } });
    expect(
      screen.getByRole("heading", { name: "The host's computer is asleep" }),
    ).toHaveFocus();
    const button = screen.getByRole("button", { name: "Try now" });
    button.focus();
    again({ failure: { kind: "offline" } });
    expect(button).toHaveFocus();
  });

  it.each([
    ["unreachable", "offline", "You're offline."],
    ["offline", "unreachable", "The host's computer is asleep."],
    ["unreachable", "server", "This link did not load."],
  ] as const)(
    "says the new title, not Still, when a press on the %s cover is answered by the %s cover",
    (from, to, sentence) => {
      const { again } = renderCover({ kind: from });
      const status = screen.getByRole("status");
      fireEvent.click(screen.getAllByRole("button")[0]!);
      again({ trying: true });
      again({ trying: false, failure: { kind: to } });
      act(() => void vi.advanceTimersByTime(600));
      expect(status).toBe(screen.getByRole("status"));
      expect(status).toHaveTextContent(sentence);
      expect(status).not.toHaveTextContent(/still/i);
    },
  );

  it("says Still again when the cover returns to the title that was pressed", () => {
    const { again } = renderCover({ kind: "unreachable" });
    fireEvent.click(screen.getByRole("button", { name: "Try now" }));
    again({ trying: true });
    again({ trying: false, failure: { kind: "offline" } });
    again({ failure: { kind: "unreachable" } });
    act(() => void vi.advanceTimersByTime(600));
    expect(screen.getByRole("status")).toHaveTextContent("Still asleep.");
  });

  it("does not take focus from the button when the title changes", () => {
    const { again } = renderCover({ kind: "unreachable" });
    const button = screen.getByRole("button", { name: "Try now" });
    button.focus();
    again({ failure: { kind: "server" } });
    expect(
      screen.getByRole("heading", { name: "This link did not load" }),
    ).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Retry" })).toHaveFocus();
  });

  it("moves focus to the new title when focus is outside the cover", () => {
    const { again } = renderCover({ kind: "unreachable" });
    (document.activeElement as HTMLElement | null)?.blur();
    again({ failure: { kind: "server" } });
    expect(
      screen.getByRole("heading", { name: "This link did not load" }),
    ).toHaveFocus();
  });

  it("has no button and no status for a link that opens nothing", () => {
    renderCover({ kind: "bad-link" });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.getByText("Ask the person who sent it for a new link."),
    ).toBeInTheDocument();
  });

  it("moves focus to the new title when a press is answered by a cover with no button", () => {
    const { again } = renderCover({ kind: "unreachable" });
    const retry = screen.getByRole("button", { name: "Try now" });
    retry.focus();
    fireEvent.click(retry);
    again({ trying: true });
    act(() => void vi.advanceTimersByTime(HELD_BUSY_MS));
    again({ failure: { kind: "restricted" }, trying: false });
    expect(
      screen.getByRole("heading", { name: "This link did not load" }),
    ).toHaveFocus();
  });

  it("keeps focus on the button when the same kind of cover answers", () => {
    const { again } = renderCover({ kind: "unreachable" });
    const retry = screen.getByRole("button", { name: "Try now" });
    retry.focus();
    fireEvent.click(retry);
    again({ trying: true });
    act(() => void vi.advanceTimersByTime(HELD_BUSY_MS));
    again({ trying: false });
    expect(screen.getByRole("button", { name: "Try now" })).toHaveFocus();
  });

  it("has no accessibility violations at rest or while busy", async () => {
    vi.useRealTimers();
    const { container, again } = renderCover({ kind: "server" });
    await expectNoA11yViolations(container);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    again({ trying: true });
    await expectNoA11yViolations(container);
  });
});

describe("GuestPageCover with text the guest had not sent", () => {
  const comment = { label: "Your comment", text: "Cut the pause at 1:05" };
  const reply = { label: "Your reply", text: "Agreed, trim it." };
  const note = { label: "Your note", text: "Please keep the laugh." };

  function renderUnsent(unsent: UnsentText[]) {
    return render(
      <GuestPageCover
        failure={{ kind: "bad-link" }}
        trying={false}
        onRetry={vi.fn()}
        unsent={unsent}
      />,
    );
  }
  function stubClipboard(write: (text: string) => Promise<void>) {
    const writeText = vi.fn(write);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    return writeText;
  }
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("keeps the words of the cover and adds nothing to it when nothing was typed", () => {
    for (const unsent of [undefined, []]) {
      const { container, unmount } = render(
        <GuestPageCover
          failure={{ kind: "bad-link" }}
          trying={false}
          onRetry={vi.fn()}
          unsent={unsent}
        />,
      );
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "This link doesn't open anything",
      );
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
      expect(container.querySelector(".guest-page-cover--unsent")).toBeNull();
      unmount();
    }
  });

  it("marks a cover with unsent text as short only in a short window, and a cover without text never", () => {
    const query = "(max-height: 30rem)";
    const stub = (short: boolean) =>
      vi.stubGlobal("matchMedia", (asked: string) => ({
        matches: short && asked === query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
    stub(true);
    const withText = render(
      <GuestPageCover
        failure={{ kind: "bad-link" }}
        trying={false}
        onRetry={vi.fn()}
        unsent={[comment]}
      />,
    );
    expect(withText.container.querySelector("main")).toHaveClass(
      "guest-page-cover--unsent",
      "guest-page-cover--short",
    );
    withText.unmount();
    const without = render(
      <GuestPageCover
        failure={{ kind: "bad-link" }}
        trying={false}
        onRetry={vi.fn()}
      />,
    );
    expect(without.container.querySelector("main")).not.toHaveClass(
      "guest-page-cover--short",
    );
    without.unmount();
    stub(false);
    const tall = render(
      <GuestPageCover
        failure={{ kind: "bad-link" }}
        trying={false}
        onRetry={vi.fn()}
        unsent={[comment]}
      />,
    );
    expect(tall.container.querySelector("main")).not.toHaveClass(
      "guest-page-cover--short",
    );
    tall.unmount();
    vi.unstubAllGlobals();
  });

  it.each([
    [comment, "Your comment was not posted", "Copy your comment"],
    [reply, "Your reply was not posted", "Copy your reply"],
    [note, "Your note was not posted", "Copy your note"],
  ])("names one text by its label (%#)", (one, heading, button) => {
    renderUnsent([one]);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This link doesn't open anything",
    );
    expect(
      screen.getByText("Ask the person who sent it for a new link."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: heading, level: 2 }),
    ).toBeVisible();
    const area = screen.getByRole("textbox", { name: heading });
    expect(area).toHaveValue(one.text);
    expect(area).toHaveAttribute("readonly");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: button })).toBeVisible();
  });

  it("puts several texts in one box with their labels, a blank line between, and one Copy all", () => {
    renderUnsent([comment, reply, note]);
    expect(
      screen.getByRole("textbox", { name: "These were not posted" }),
    ).toHaveValue(
      "Your comment:\nCut the pause at 1:05\n\nYour reply:\nAgreed, trim it.\n\nYour note:\nPlease keep the laugh.",
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Copy all" })).toBeVisible();
  });

  it("copies the text exactly, says Copied, and clears it after three seconds", async () => {
    vi.useFakeTimers();
    const writeText = stubClipboard(async () => {});
    renderUnsent([{ label: "Your comment", text: "  keep\n  spacing " }]);
    const button = screen.getByRole("button", { name: "Copy your comment" });
    button.focus();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("  keep\n  spacing ");
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    expect(button).toHaveFocus();
    act(() => {
      vi.advanceTimersByTime(2_900);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole("status")).toHaveTextContent(/^$/);
    vi.useRealTimers();
  });

  it("keeps Copied for three seconds after the last press when two presses overlap", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    let presses = 0;
    stubClipboard(() => {
      presses += 1;
      return presses === 1
        ? new Promise<void>((done) => {
            release = done;
          })
        : Promise.resolve();
    });
    renderUnsent([comment]);
    const button = screen.getByRole("button", { name: "Copy your comment" });
    // The first press is still waiting for the clipboard when the second one answers.
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    await act(async () => {
      release();
    });
    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    // Three seconds after the second press, but only 2.5 s after the later answer.
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByRole("status")).toHaveTextContent(/^$/);
    vi.useRealTimers();
  });

  it("selects the text and says so when the clipboard refuses", async () => {
    stubClipboard(() =>
      Promise.reject(new DOMException("no", "NotAllowedError")),
    );
    renderUnsent([comment]);
    await userEvent.click(
      screen.getByRole("button", { name: "Copy your comment" }),
    );
    const area = screen.getByRole("textbox", {
      name: "Your comment was not posted",
    }) as HTMLTextAreaElement;
    expect(area).toHaveFocus();
    expect([area.selectionStart, area.selectionEnd]).toEqual([
      0,
      comment.text.length,
    ]);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Couldn't copy. The text is selected, so you can copy it by hand.",
    );
  });

  it("does the same when the page has no clipboard at all", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    renderUnsent([comment]);
    await userEvent.click(
      screen.getByRole("button", { name: "Copy your comment" }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(/Couldn't copy/);
    expect(
      screen.getByRole("textbox", { name: "Your comment was not posted" }),
    ).toHaveFocus();
  });

  it("holds the refusal line until the next press", async () => {
    vi.useFakeTimers();
    stubClipboard(() => Promise.reject(new Error("no")));
    renderUnsent([comment]);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Copy your comment" }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByRole("status")).toHaveTextContent(/Couldn't copy/);
    vi.useRealTimers();
  });

  it("takes focus to the title when it arrives", () => {
    renderUnsent([comment]);
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  });

  it("holds a very long text in its box and has no accessibility violations", async () => {
    vi.useRealTimers();
    const long = "A long thought. ".repeat(320);
    const { container } = renderUnsent([{ label: "Your comment", text: long }]);
    expect(
      screen.getByRole("textbox", { name: "Your comment was not posted" }),
    ).toHaveValue(long);
    await expectNoA11yViolations(container);
  });

  it("lets the text's own first letter set its direction, and copies it unchanged (a single text only: with several, the label comes first)", async () => {
    const hebrew = { label: "Your comment", text: "לחתוך את ההפסקה בדקה 1:05" };
    const writeText = stubClipboard(async () => {});
    renderUnsent([hebrew]);
    const box = screen.getByRole("textbox", {
      name: "Your comment was not posted",
    });
    expect(box).toHaveAttribute("dir", "auto");
    expect(box).toHaveValue(hebrew.text);
    await userEvent.click(
      screen.getByRole("button", { name: "Copy your comment" }),
    );
    expect(writeText).toHaveBeenCalledWith(hebrew.text);
  });
});
