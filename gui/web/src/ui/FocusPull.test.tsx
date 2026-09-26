import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
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
    vi.unstubAllGlobals();
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

  it("keeps both views mounted once as their slots change phase", async () => {
    vi.useFakeTimers();
    const mounts = vi.fn();
    const unmounts = vi.fn();
    function View({ name }: { name: string }) {
      useEffect(() => {
        mounts(name);
        return () => unmounts(name);
      }, [name]);
      return <button type="button">{name}</button>;
    }
    const { container, rerender } = render(
      <FocusPull viewKey="lobby">
        <View name="lobby" />
      </FocusPull>,
    );
    const lobby = container.querySelector("button");
    rerender(
      <FocusPull viewKey="room">
        <View name="room" />
      </FocusPull>,
    );
    expect(container.querySelector(".focus-pull-exit button")).toBe(lobby);
    const room = container.querySelector<HTMLButtonElement>(
      ".focus-pull-pending button",
    );
    expect(mounts.mock.calls).toEqual([["lobby"], ["room"]]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOCUS_PULL_EXIT_MS);
    });
    expect(container.querySelector(".focus-pull-enter button")).toBe(room);
    room?.focus();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOCUS_PULL_ENTER_MS);
    });
    expect(container.querySelector(".focus-pull-current button")).toBe(room);
    expect(document.activeElement).toBe(room);
    expect(mounts.mock.calls).toEqual([["lobby"], ["room"]]);
    expect(unmounts.mock.calls).toEqual([["lobby"]]);
  });

  it("keeps the first exit deadline when the destination changes", async () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <FocusPull viewKey="a">
        <p>A</p>
      </FocusPull>,
    );
    rerender(
      <FocusPull viewKey="b">
        <p>B</p>
      </FocusPull>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOCUS_PULL_EXIT_MS - 1);
    });
    const outgoing = container.querySelector(".focus-pull-exit");
    rerender(
      <FocusPull viewKey="c">
        <p>C</p>
      </FocusPull>,
    );
    expect(container.querySelector(".focus-pull-exit")).toBe(outgoing);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(container.querySelector(".focus-pull-enter")?.textContent).toBe("C");
    expect(container.textContent).not.toContain("B");
  });

  it("updates incoming content without resetting the exit clock", async () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <FocusPull viewKey="a">
        <p>A</p>
      </FocusPull>,
    );
    rerender(
      <FocusPull viewKey="b">
        <p>B one</p>
      </FocusPull>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOCUS_PULL_EXIT_MS - 1);
    });
    rerender(
      <FocusPull viewKey="b">
        <p>B two</p>
      </FocusPull>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(container.querySelector(".focus-pull-enter")?.textContent).toBe(
      "B two",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOCUS_PULL_ENTER_MS);
    });
    expect(container.querySelector(".focus-pull-current")?.textContent).toBe(
      "B two",
    );
  });

  it("promotes the latest incoming content on an enter interruption", async () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <FocusPull viewKey="a">
        <p>A</p>
      </FocusPull>,
    );
    rerender(
      <FocusPull viewKey="b">
        <p>B one</p>
      </FocusPull>,
    );
    rerender(
      <FocusPull viewKey="b">
        <p>B two</p>
      </FocusPull>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOCUS_PULL_EXIT_MS);
    });
    expect(container.querySelector(".focus-pull-exit")?.textContent).toBe("A");
    expect(container.querySelector(".focus-pull-enter")?.textContent).toBe(
      "B two",
    );
    rerender(
      <FocusPull viewKey="c">
        <p>C</p>
      </FocusPull>,
    );
    expect(container.querySelector(".focus-pull-exit")?.textContent).toBe(
      "B two",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector(".focus-pull-enter")?.textContent).toBe("C");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOCUS_PULL_ENTER_MS);
    });
    expect(container.querySelector(".focus-pull-current")?.textContent).toBe(
      "C",
    );
  });

  it("cancels the exit when the original view returns", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <FocusPull viewKey="a">
        <p>A</p>
      </FocusPull>,
    );
    const original = container.querySelector(".focus-pull-current");
    rerender(
      <FocusPull viewKey="b">
        <p>B</p>
      </FocusPull>,
    );
    rerender(
      <FocusPull viewKey="a">
        <p>A updated</p>
      </FocusPull>,
    );
    expect(container.querySelector(".focus-pull-current")).toBe(original);
    expect(container.textContent).toBe("A updated");
    expect(container.querySelector(".focus-pull-pending")).toBeNull();
  });

  it("does not move focus when the original view returns during exit", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <FocusPull viewKey="a">
        <button type="button">A</button>
      </FocusPull>,
    );
    const original = container.querySelector("button");
    original?.focus();
    rerender(
      <FocusPull viewKey="b">
        <button type="button">B</button>
      </FocusPull>,
    );
    rerender(
      <FocusPull viewKey="a">
        <button type="button">A updated</button>
      </FocusPull>,
    );
    expect(document.activeElement).toBe(original);
    expect(container.querySelector(".focus-pull-current button")).toBe(
      original,
    );
  });

  it("promotes the entering view on interruption and clears timers on unmount", async () => {
    vi.useFakeTimers();
    const { container, rerender, unmount } = render(
      <FocusPull viewKey="a">
        <p>A</p>
      </FocusPull>,
    );
    rerender(
      <FocusPull viewKey="b">
        <p>B</p>
      </FocusPull>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOCUS_PULL_EXIT_MS);
    });
    const b = container.querySelector(".focus-pull-enter");
    rerender(
      <FocusPull viewKey="c">
        <p>C</p>
      </FocusPull>,
    );
    expect(container.querySelector(".focus-pull-exit")).toBe(b);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector(".focus-pull-enter")?.textContent).toBe("C");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("moves focus to the entering view when the outgoing view held it", async () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <FocusPull viewKey="a">
        <button type="button">A</button>
      </FocusPull>,
    );
    container.querySelector("button")?.focus();
    rerender(
      <FocusPull viewKey="b">
        <button type="button">B</button>
      </FocusPull>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOCUS_PULL_EXIT_MS);
    });
    const b = container.querySelector(".focus-pull-enter button");
    expect(document.activeElement).toBe(b);
    rerender(
      <FocusPull viewKey="c">
        <button type="button">C</button>
      </FocusPull>,
    );
    expect(container.querySelector(".focus-pull-exit button")).toBe(b);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.activeElement).toBe(
      container.querySelector(".focus-pull-enter button"),
    );
  });

  it("skips hidden and inert controls when moving focus", async () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <FocusPull viewKey="a">
        <button type="button">A</button>
      </FocusPull>,
    );
    container.querySelector("button")?.focus();
    rerender(
      <FocusPull viewKey="b">
        <button type="button" style={{ visibility: "hidden" }}>
          Hidden
        </button>
        <span inert>
          <button type="button">Inert</button>
        </span>
        <button type="button">Visible</button>
      </FocusPull>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOCUS_PULL_EXIT_MS);
    });
    expect(document.activeElement?.textContent).toBe("Visible");
  });

  it("leaves focus outside the view alone when exit finishes", async () => {
    vi.useFakeTimers();
    const external = document.createElement("button");
    document.body.append(external);
    try {
      const { container, rerender } = render(
        <FocusPull viewKey="a">
          <button type="button">A</button>
        </FocusPull>,
      );
      container.querySelector("button")?.focus();
      rerender(
        <FocusPull viewKey="b">
          <button type="button">B</button>
        </FocusPull>,
      );
      external.focus();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FOCUS_PULL_EXIT_MS);
      });
      expect(document.activeElement).toBe(external);
    } finally {
      external.remove();
    }
  });

  it("does not render a same-key child a second time", () => {
    const renders = vi.fn();
    function View({ label }: { label: string }) {
      renders(label);
      return <p>{label}</p>;
    }
    const { rerender } = render(
      <FocusPull viewKey="a">
        <View label="first" />
      </FocusPull>,
    );
    rerender(
      <FocusPull viewKey="a">
        <View label="second" />
      </FocusPull>,
    );
    expect(renders.mock.calls).toEqual([["first"], ["second"]]);
  });

  it("keeps the latest same-key DOM mounted as it becomes outgoing", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <FocusPull viewKey="a">
        <p>Waiting</p>
      </FocusPull>,
    );
    rerender(
      <FocusPull viewKey="a">
        <select aria-label="Input">
          <option>Microphone</option>
        </select>
      </FocusPull>,
    );
    const select = container.querySelector("select");
    select?.focus();
    rerender(
      <FocusPull viewKey="b">
        <button type="button">Room</button>
      </FocusPull>,
    );
    expect(container.querySelector(".focus-pull-exit select")).toBe(select);
  });

  it("cuts immediately under reduced motion without leaving timers", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const { container, rerender } = render(
      <FocusPull viewKey="a">
        <button type="button">A</button>
      </FocusPull>,
    );
    container.querySelector("button")?.focus();
    const setTimeout = vi.spyOn(window, "setTimeout");
    rerender(
      <FocusPull viewKey="b">
        <button type="button">B</button>
      </FocusPull>,
    );
    expect(container.querySelector(".focus-pull-current")?.textContent).toBe(
      "B",
    );
    expect(document.activeElement?.textContent).toBe("B");
    expect(
      setTimeout.mock.calls.some(
        ([, delay]) =>
          delay === FOCUS_PULL_EXIT_MS || delay === FOCUS_PULL_ENTER_MS,
      ),
    ).toBe(false);
  });

  it("finishes an active transition when reduced motion turns on", () => {
    vi.useFakeTimers();
    let onChange: ((event: { matches: boolean }) => void) | undefined;
    const removeEventListener = vi.fn();
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: (_: string, listener: typeof onChange) => {
        onChange = listener;
      },
      removeEventListener,
    }));
    const { container, rerender, unmount } = render(
      <FocusPull viewKey="a">
        <button type="button">A</button>
      </FocusPull>,
    );
    container.querySelector("button")?.focus();
    rerender(
      <FocusPull viewKey="b">
        <button type="button">B</button>
      </FocusPull>,
    );
    act(() => onChange?.({ matches: true }));
    expect(container.querySelector(".focus-pull-current")?.textContent).toBe(
      "B",
    );
    expect(document.activeElement?.textContent).toBe("B");
    unmount();
    expect(removeEventListener).toHaveBeenCalledWith("change", onChange);
  });

  it("shows the destination immediately under reduced motion", () => {
    const ui = readFileSync(join(SRC_ROOT, "styles/partials/ui.css"), "utf8");
    expect(ui).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.focus-pull-exit\s*\{\s*display:\s*none/s,
    );
    expect(ui).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.focus-pull-pending,[\s\S]*?\.focus-pull-enter\s*\{[^}]*visibility:\s*visible/s,
    );
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
