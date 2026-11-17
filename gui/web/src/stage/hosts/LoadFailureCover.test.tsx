import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type HostLoadKind,
  type ShellFailure,
  type ShellGuestFailure,
  shellFailureCover,
} from "../../shellLoadFailure";
import { HELD_BUSY_MS } from "../../system/useHeldBusy";
import { expectNoA11yViolations } from "../../test/a11y";
import type { StageId } from "../../types/stage";
import { LoadFailureCover } from "./HostBody";
import type { LoadFailure } from "./hostModels";

type Shell = Extract<LoadFailure, { source: "shell" }>;

function shell(cause: ShellFailure, extra: Partial<Shell> = {}): Shell {
  return {
    source: "shell",
    cause,
    name: "Rosa and Maya",
    onRetry: vi.fn(),
    onHome: cause.audience === "host" ? vi.fn() : undefined,
    ...extra,
  };
}

const hostCause = (kind: HostLoadKind): ShellFailure => ({
  audience: "host",
  kind,
});

function show(failure: LoadFailure | null, stage: StageId = "edit") {
  const ui = (f: LoadFailure | null) => (
    <LoadFailureCover stage={stage} failure={f} />
  );
  const view = render(ui(failure));
  return { ...view, again: (f: LoadFailure | null) => view.rerender(ui(f)) };
}

function expectButtons(labels: readonly string[]) {
  const found = screen.queryAllByRole("button");
  expect(found).toHaveLength(labels.length);
  labels.forEach((label, i) => {
    expect(found[i]).toHaveAccessibleName(label);
  });
}

describe("the studio's own load-failure cover, for a host", () => {
  it.each([
    ["missing", ["All projects", "Try again"]],
    ["damaged", ["All projects", "Try again"]],
    ["busy", ["Try again"]],
    ["elsewhere", ["All projects"]],
    ["not-answering", ["Try again"]],
    ["other", ["Try again", "All projects"]],
  ] as const)(
    "a %s episode has its title, its one sentence and its buttons in order",
    (kind, labels) => {
      const failure = shell(hostCause(kind));
      show(failure);
      const cover = shellFailureCover(failure.cause, {
        stageTitle: "Could not load the project",
        name: "Rosa and Maya",
      });
      const alert = screen.getByRole("alert");
      expect(within(alert).getByRole("heading")).toHaveTextContent(cover.title);
      expect(alert).toHaveTextContent(cover.sentence);
      expectButtons(labels);
    },
  );

  it("prints the episode's name and never a path", () => {
    show(shell(hostCause("missing"), { name: "Rosa and Maya" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      `ShareCut can't find "Rosa and Maya".`,
    );
    expect(screen.getByRole("alert").textContent).not.toMatch(/[\\/]/);
  });

  it("goes to all projects, and tries again", async () => {
    const failure = shell(hostCause("other"));
    show(failure);
    await userEvent.click(screen.getByRole("button", { name: "All projects" }));
    expect(failure.onHome).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(failure.onRetry).toHaveBeenCalledOnce();
  });

  it("titles the Review region's failure as the transcript's", () => {
    show(shell(hostCause("other")), "review");
    expect(screen.getByRole("heading")).toHaveTextContent(
      "The transcript didn't load",
    );
  });

  it("keeps the cause's own title where it has one", () => {
    show(shell(hostCause("elsewhere")), "review");
    expect(screen.getByRole("heading")).toHaveTextContent(
      "This episode isn't open on this computer",
    );
  });

  it("has no retry button or status line when trying again cannot help", () => {
    show(shell(hostCause("elsewhere")));
    expect(screen.queryByRole("button", { name: /Try/ })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers no All projects when it has nothing to run", () => {
    show(shell(hostCause("missing"), { onHome: undefined }));
    expectButtons(["Try again"]);
  });
});

describe("the studio's own load-failure cover, for a guest", () => {
  const guest = (failure: ShellGuestFailure) =>
    shell({ audience: "guest", failure }, { name: "" });

  it.each([
    [{ kind: "unreachable" }, "The host's computer is asleep", ["Try now"]],
    [{ kind: "offline" }, "You're offline", ["Try now"]],
    [{ kind: "busy" }, "Could not load the project", ["Try again"]],
    [{ kind: "doubt" }, "Could not load the project", ["Try again"]],
    [{ kind: "sign-in" }, "Could not load the project", []],
    [{ kind: "restricted" }, "Could not load the project", []],
    [{ kind: "server" }, "Could not load the project", ["Try again"]],
  ] as const)(
    "%j says %s with buttons %j and never All projects",
    (failure, title, labels) => {
      show(guest(failure));
      expect(screen.getByRole("heading")).toHaveTextContent(title);
      expectButtons(labels);
    },
  );
});

describe("a press on the cover's button", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps the button node, its focus and the sentence, and says what came of it", () => {
    const failure = shell(hostCause("not-answering"));
    const { again } = show(failure);
    const retry = screen.getByRole("button", { name: "Try again" });
    const sentence = () =>
      screen.getByRole("alert").querySelector(".sys-cover-text")?.textContent;
    const before = sentence();
    retry.focus();
    act(() => retry.click());
    expect(failure.onRetry).toHaveBeenCalledOnce();
    again({ ...failure, trying: true });
    expect(screen.getByRole("button", { name: "Trying…" })).toBe(retry);
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Trying again…");
    expect(sentence()).toBe(before);

    again({ ...failure, trying: false });
    act(() => void vi.advanceTimersByTime(HELD_BUSY_MS));
    expect(screen.getByRole("button", { name: "Try again" })).toBe(retry);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Still not answering.",
    );
    expect(sentence()).toBe(before);
  });

  it("says what the new cause is when a different failure answers", () => {
    const failure = shell(hostCause("not-answering"));
    const { again } = show(failure);
    act(() => screen.getByRole("button", { name: "Try again" }).click());
    again({ ...failure, trying: true });
    act(() => void vi.advanceTimersByTime(HELD_BUSY_MS));
    again(shell(hostCause("busy"), { trying: false }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "The episode is busy.",
    );
  });

  it("stays silent about an attempt nobody pressed", () => {
    const failure = shell(
      { audience: "guest", failure: { kind: "unreachable" } },
      { name: "" },
    );
    const { again } = show(failure);
    again({ ...failure, trying: true });
    expect(screen.getByRole("button", { name: "Try now" })).not.toHaveAttribute(
      "aria-busy",
    );
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});

describe("focus after a press answered by a different cover", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Press Try again on `first`, then let `next` answer it. */
  function pressThenAnswer(
    first: Shell,
    next: Shell,
    whileBusy: () => void = () => {},
  ) {
    const { again } = show(first);
    const retry = screen.getByRole("button", { name: "Try again" });
    retry.focus();
    act(() => retry.click());
    again({ ...first, trying: true });
    whileBusy();
    act(() => void vi.advanceTimersByTime(HELD_BUSY_MS));
    again({ ...next, trying: false });
    return again;
  }

  it("stays on Try again when the new cover still offers it, in another place", () => {
    pressThenAnswer(shell(hostCause("missing")), shell(hostCause("other")));
    expectButtons(["Try again", "All projects"]);
    expect(screen.getByRole("button", { name: "Try again" })).toHaveFocus();
  });

  it("stays on Try again when the same cover answers", () => {
    pressThenAnswer(
      shell(hostCause("not-answering")),
      shell(hostCause("not-answering")),
    );
    expect(screen.getByRole("button", { name: "Try again" })).toHaveFocus();
  });

  /** A parent that, like the Review stage, takes focus back to its own root when focus that was inside it falls to the body. */
  function RescuingStage({ children }: { children: ReactNode }) {
    const root = useRef<HTMLDivElement>(null);
    const wasInside = useRef(false);
    useLayoutEffect(() => {
      const el = root.current;
      if (!el) return;
      if (wasInside.current && document.activeElement === document.body) {
        el.focus();
      }
      wasInside.current = el.contains(document.activeElement);
    });
    return (
      <div ref={root} tabIndex={-1} data-testid="stage">
        {children}
      </div>
    );
  }

  /** Press Try again on `first` and let `next` answer while the busy hold is still on. */
  function pressThenAnswerAtOnce(first: Shell, next: Shell) {
    const ui = (f: Shell) => (
      <RescuingStage>
        <LoadFailureCover stage="review" failure={f} />
      </RescuingStage>
    );
    const view = render(ui(first));
    const retry = screen.getByRole("button", { name: "Try again" });
    retry.focus();
    act(() => retry.click());
    view.rerender(ui({ ...first, trying: true }));
    act(() => void vi.advanceTimersByTime(HELD_BUSY_MS / 4));
    view.rerender(ui({ ...next, trying: false }));
  }

  it("puts focus on the title at once when a cover with no button answers inside a parent that rescues focus", () => {
    pressThenAnswerAtOnce(
      shell({ audience: "guest", failure: { kind: "server" } }, { name: "" }),
      shell({ audience: "guest", failure: { kind: "sign-in" } }, { name: "" }),
    );
    expect(screen.getByRole("heading")).toHaveFocus();
  });

  it("puts focus on Try again at once when missing is answered by other, not on the node that now says All projects", () => {
    pressThenAnswerAtOnce(
      shell(hostCause("missing")),
      shell(hostCause("other")),
    );
    expect(screen.getByRole("button", { name: "Trying…" })).toHaveFocus();
  });

  it("does not take focus back from a button outside the cover", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    pressThenAnswer(
      shell(hostCause("other")),
      shell(hostCause("elsewhere")),
      () => outside.focus(),
    );
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it("moves to the title when the new cover has no Try again", () => {
    pressThenAnswer(shell(hostCause("other")), shell(hostCause("elsewhere")));
    expect(screen.getByRole("heading")).toHaveFocus();
  });

  it("moves a guest to the title when the new cover has no button at all", () => {
    pressThenAnswer(
      shell({ audience: "guest", failure: { kind: "server" } }, { name: "" }),
      shell({ audience: "guest", failure: { kind: "sign-in" } }, { name: "" }),
    );
    expect(screen.getByRole("heading")).toHaveFocus();
  });

  it("leaves focus alone when the cover changes without a press", () => {
    const first = shell(
      { audience: "guest", failure: { kind: "unreachable" } },
      { name: "" },
    );
    const { again } = show(first);
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    again({ ...first, trying: true });
    again(
      shell(
        { audience: "guest", failure: { kind: "restricted" } },
        { name: "", trying: false },
      ),
    );
    expect(elsewhere).toHaveFocus();
    elsewhere.remove();
  });
});

describe("the transcript's own failure", () => {
  it("reads its fixed words with the button and no status line", async () => {
    const onRetry = vi.fn();
    show({ source: "detail", onRetry }, "review");
    const alert = screen.getByRole("alert");
    expect(within(alert).getByRole("heading")).toHaveTextContent(
      "The transcript didn't load",
    );
    expect(alert).toHaveTextContent("Try again in a moment.");
    expect(screen.queryByRole("status")).toBeNull();
    vi.useRealTimers();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("holds the button busy while recovering, with no status line", () => {
    show({ source: "detail", onRetry: vi.fn(), recovering: true });
    expect(screen.getByRole("button", { name: "Try again" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("accessibility", () => {
  it.each([
    shell(hostCause("missing")),
    shell(hostCause("elsewhere")),
    shell({ audience: "guest", failure: { kind: "offline" } }, { name: "" }),
  ])("has no axe violations", async (failure) => {
    const { container } = show(failure);
    await expectNoA11yViolations(container);
  });
});
