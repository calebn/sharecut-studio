import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHORT_VIEWPORT_MQ } from "../../hooks/useShortViewport";
import { PHONE_MQ, TABLET_MQ } from "../../hooks/useViewportClass";
import { useDawStore } from "../../state/dawStore";
import type { ShellBreakpoint } from "../../state/types";
import { minimalProject } from "../../test/fixtures";
import type { CombinedUtterance } from "../../types/project";
import { ReviewHost } from "./ReviewHost";
import { StageHost } from "./StageHost";

function project() {
  const utterances: CombinedUtterance[] = [
    {
      track_id: "t1",
      source_id: "s1",
      speaker: "Maya",
      start: 0,
      end: 3,
      text: "one two three",
      words: ["one", "two", "three"].map((text, index) => ({
        text,
        start: index,
        end: index + 0.5,
        timeline_start: 10 + index,
        timeline_end: 10.5 + index,
      })),
    },
  ];
  return minimalProject({
    transcript: { utterances },
    timeline_duration_sec: 60,
  });
}

function join(path = "share:follow") {
  useDawStore.getState().hydrate(path, project(), "view", ["view", "play"]);
  useDawStore.setState({ stage: "review", playheadSec: 10.1 });
}

function viewport(initialShell: ShellBreakpoint) {
  let shell = initialShell;
  let layoutShort = false;
  useDawStore.setState({ shellBreakpoint: initialShell });
  const visual = Object.assign(new EventTarget(), {
    height: 800,
    width: 400,
    scale: 1,
  });
  vi.stubGlobal("visualViewport", visual);
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      if (query === SHORT_VIEWPORT_MQ) return layoutShort;
      if (query === PHONE_MQ) return shell === "phone";
      if (query === TABLET_MQ) return shell !== "desktop";
      return false;
    },
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const resize = () => window.dispatchEvent(new Event("resize"));
  return {
    shell: (next: ShellBreakpoint) =>
      act(() => {
        shell = next;
        useDawStore.setState({ shellBreakpoint: next });
        resize();
      }),
    short: (via: "layout" | "visual", next: boolean) =>
      act(() => {
        if (via === "layout") layoutShort = next;
        else visual.height = next ? 400 : 800;
        visual.dispatchEvent(new Event("resize"));
        resize();
      }),
  };
}

const body = () => {
  const element = document.querySelector<HTMLElement>(".sys-script-body");
  expect(element).not.toBeNull();
  return element as HTMLElement;
};
const back = () => screen.getByRole("button", { name: "Back to playhead" });
const moveTo = (playheadSec: number) =>
  act(() => useDawStore.setState({ playheadSec }));

function readAway() {
  const reader = body();
  fireEvent.wheel(reader);
  reader.scrollTop = 123;
  fireEvent.scroll(reader);
  expect(back()).toBeVisible();
  return reader;
}

describe("guest Review transcript follow lifetime", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
    const original = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        if (this.classList.contains("sys-script-body"))
          return new DOMRect(0, 0, 100, 200);
        if (this.classList.contains("sys-script-word")) {
          const reader = this.closest<HTMLElement>(".sys-script-body");
          const index = Number(this.getAttribute("data-stop"));
          return new DOMRect(
            0,
            (index + 1) * 1000 - (reader?.scrollTop ?? 0),
            100,
            20,
          );
        }
        return original.call(this);
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["layout", "visual"] as const)(
    "keeps a phone reader's pause and position after a short %s viewport recovers",
    (via) => {
      const size = viewport("phone");
      join();
      render(<ReviewHost guestShare />);
      readAway();

      size.short(via, true);
      expect(document.querySelector(".sys-script-body")).toBeNull();
      moveTo(11.1);
      size.short(via, false);

      expect(back()).toBeVisible();
      expect(body().scrollTop).toBe(123);
      moveTo(12.1);
      expect(back()).toBeVisible();
      expect(body().scrollTop).toBe(123);
    },
  );

  it.each([
    ["phone", "desktop"],
    ["desktop", "phone"],
  ] as const)(
    "keeps a reader's pause and position when the Player card changes from %s to %s",
    (from, to) => {
      const size = viewport(from);
      join();
      render(<ReviewHost guestShare />);
      readAway();
      expect(document.querySelector(".sys-player--expanded") !== null).toBe(
        from === "desktop",
      );

      size.shell(to);

      expect(document.querySelector(".sys-player--expanded") !== null).toBe(
        to === "desktop",
      );
      expect(back()).toBeVisible();
      expect(body().scrollTop).toBe(123);
      moveTo(11.1);
      expect(body().scrollTop).toBe(123);
      expect(back()).toBeVisible();
    },
  );

  it("follows initially, pauses for manual reading, and resumes only through Back to playhead", () => {
    viewport("phone");
    join();
    render(<ReviewHost guestShare />);
    moveTo(11.1);
    expect(body().scrollTop).toBe(1820);
    readAway();
    moveTo(12.1);
    expect(body().scrollTop).toBe(123);

    fireEvent.click(back());

    expect(body().scrollTop).toBe(2910);
    expect(
      screen.queryByRole("button", { name: "Back to playhead" }),
    ).toBeNull();
    moveTo(10.1);
    expect(body().scrollTop).toBe(1000);
  });

  it("retains a same-project hydration pause but starts following on a project replacement through StageHost", () => {
    viewport("phone");
    join();
    render(<StageHost guestShare />);
    readAway();

    act(() => join());

    expect(back()).toBeVisible();
    expect(body().scrollTop).toBe(123);
    moveTo(11.1);
    expect(body().scrollTop).toBe(123);

    act(() => join("share:replacement"));

    expect(screen.getByRole("button", { name: "one" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Back to playhead" }),
    ).toBeNull();
    moveTo(11.1);
    expect(body().scrollTop).toBe(1820);
  });
});
