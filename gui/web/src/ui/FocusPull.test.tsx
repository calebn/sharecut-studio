import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { SRC_ROOT } from "../test/sourceFiles";
import {
  FOCUS_PULL_ENTER_MS,
  FOCUS_PULL_EXIT_MS,
  FocusPull,
} from "./FocusPull";

describe("FocusPull", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times the swap with the motion tokens the CSS animates on", () => {
    const styles = join(SRC_ROOT, "styles");
    const tokens = readFileSync(join(styles, "theme/tokens.css"), "utf8");
    const ui = readFileSync(join(styles, "partials/ui.css"), "utf8");
    const ms = (token: string) =>
      Number(tokens.match(new RegExp(`${token}:\\s*(\\d+)ms;`))?.[1]);
    expect(ui).toMatch(/focus-pull-out var\(--motion-panel\)/);
    expect(ui).toMatch(/focus-pull-in var\(--motion-state\)/);
    expect(ms("--motion-panel")).toBe(FOCUS_PULL_EXIT_MS);
    expect(ms("--motion-state")).toBe(FOCUS_PULL_ENTER_MS);
  });

  it("does not animate its initial view", () => {
    const { container } = render(
      <FocusPull viewKey="lobby">
        <p>Lobby content</p>
      </FocusPull>,
    );
    const wrapper = container.firstElementChild;
    expect(wrapper?.classList.contains("focus-pull")).toBe(true);
    expect(wrapper?.querySelector(".focus-pull-enter")).toBeNull();
    expect(wrapper?.textContent).toBe("Lobby content");
  });

  it("keeps outgoing content for the exit, then enters the next view", async () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <FocusPull viewKey="lobby">
        <p>Lobby content</p>
      </FocusPull>,
    );
    rerender(
      <FocusPull viewKey="room">
        <p>Room content</p>
      </FocusPull>,
    );
    expect(container.querySelector(".focus-pull-exit")?.textContent).toBe(
      "Lobby content",
    );
    expect(container.querySelector(".focus-pull-pending")?.textContent).toBe(
      "Room content",
    );
    // The fading view can't take a quick second tap.
    expect(
      container.querySelector(".focus-pull-exit")?.hasAttribute("inert"),
    ).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOCUS_PULL_EXIT_MS - 1);
    });
    expect(container.querySelector(".focus-pull-exit")).not.toBeNull();
    expect(container.querySelector(".focus-pull-pending")).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(container.querySelector(".focus-pull-exit")).not.toBeNull();
    expect(container.querySelector(".focus-pull-enter")?.textContent).toBe(
      "Room content",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOCUS_PULL_ENTER_MS);
    });
    expect(container.querySelector(".focus-pull-exit")).toBeNull();
    expect(container.textContent).toBe("Room content");
  });

  it("cancels an interrupted transition before entering the stale view", async () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <FocusPull viewKey="lobby">
        <p>Lobby content</p>
      </FocusPull>,
    );
    rerender(
      <FocusPull viewKey="room">
        <p>Room content</p>
      </FocusPull>,
    );
    rerender(
      <FocusPull viewKey="finished">
        <p>Finished content</p>
      </FocusPull>,
    );

    expect(container.querySelector(".focus-pull-exit")?.textContent).toBe(
      "Lobby content",
    );
    expect(container.querySelector(".focus-pull-pending")?.textContent).toBe(
      "Finished content",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        FOCUS_PULL_EXIT_MS + FOCUS_PULL_ENTER_MS,
      );
    });
    expect(container.textContent).toBe("Finished content");
    expect(container.textContent).not.toContain("Room content");
  });

  it("is axe-clean", async () => {
    const { container } = render(
      <FocusPull viewKey="lobby">
        <p>Lobby content</p>
      </FocusPull>,
    );
    await expectNoA11yViolations(container);
  });
});
