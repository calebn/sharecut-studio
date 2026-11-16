import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const MARKER = "ZEBRA-secret-9931 db password=hunter2";

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

  it("holds none of the server's words, whatever it said", () => {
    show(guest({ kind: "server" }));
    expect(document.body.textContent).not.toContain(MARKER);
  });
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

describe("the transcript's own failure (#3884)", () => {
  it("reads as it always did", async () => {
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
