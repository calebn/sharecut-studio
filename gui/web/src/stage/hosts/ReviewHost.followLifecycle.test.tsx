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

let wordSpacing = 1000;

const fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");

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

function scrollManually(reader: HTMLElement, top: number) {
  fireEvent.wheel(reader, { deltaY: top - reader.scrollTop });
  reader.scrollTop = top;
  fireEvent.scroll(reader);
}

function readAway() {
  const reader = body();
  scrollManually(reader, 123);
  expect(back()).toBeVisible();
  return reader;
}

describe("guest Review transcript follow lifetime", () => {
  beforeEach(() => {
    wordSpacing = 1000;
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      100000,
    );
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
            (index + 1) * wordSpacing - (reader?.scrollTop ?? 0),
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
    if (fontsDescriptor)
      Object.defineProperty(document, "fonts", fontsDescriptor);
    else Reflect.deleteProperty(document, "fonts");
  });

  it.each(["layout", "visual"] as const)(
    "keeps a phone reader's pause and position while the %s viewport is short and after it recovers",
    (via) => {
      const size = viewport("phone");
      join();
      render(<ReviewHost guestShare />);
      readAway();

      size.short(via, true);
      expect(back()).toBeVisible();
      expect(body().scrollTop).toBe(123);
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

  it("keeps the latest manual reading place when fonts settle after more scrolling", () => {
    const fonts = new EventTarget();
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: fonts,
    });
    viewport("phone");
    join();
    render(<ReviewHost guestShare />);
    const reader = body();
    scrollManually(reader, 1000);
    expect(back()).toBeVisible();
    reader.scrollTop = 2000;
    fireEvent.scroll(reader);

    act(() => {
      fonts.dispatchEvent(new Event("loadingdone"));
    });

    expect(reader.scrollTop).toBe(2000);
    expect(back()).toBeVisible();
  });

  it("retains the place a reader paused after playback has scrolled the pane", () => {
    const size = viewport("phone");
    join();
    render(<ReviewHost guestShare />);
    moveTo(11.1);
    const reader = body();
    expect(reader.scrollTop).toBe(1820);
    scrollManually(reader, 1830);
    expect(back()).toBeVisible();

    size.short("layout", true);
    size.short("layout", false);

    expect(back()).toBeVisible();
    expect(body().scrollTop).toBe(1830);
  });

  it("keeps a captured word offset when a shell move rebuilds the guest transcript", () => {
    const size = viewport("phone");
    join();
    render(<ReviewHost guestShare />);
    const reader = body();
    scrollManually(reader, 1990);
    expect(back()).toBeVisible();
    expect(
      screen.getByRole("button", { name: "two" }).getBoundingClientRect().top,
    ).toBe(10);

    wordSpacing = 500;
    size.shell("desktop");

    expect(body()).not.toBe(reader);
    expect(body().scrollTop).toBe(990);
    expect(
      screen.getByRole("button", { name: "two" }).getBoundingClientRect().top,
    ).toBe(10);
    expect(back()).toBeVisible();
  });

  it("uses the captured pixel fallback after same-project hydration reassigns an ordinal", () => {
    const size = viewport("phone");
    join();
    render(<ReviewHost guestShare />);
    const reader = body();
    scrollManually(reader, 1990);
    expect(
      screen.getByRole("button", { name: "two" }).getBoundingClientRect().top,
    ).toBe(10);
    size.short("layout", true);
    const changed = project();
    const firstWord = changed.transcript?.utterances[0].words?.[0];
    if (!firstWord) throw new Error("Expected the first transcript word");
    firstWord.suppressed = true;
    wordSpacing = 500;
    act(() => {
      useDawStore
        .getState()
        .hydrate("share:follow", changed, "view", ["view", "play"]);
    });
    size.short("layout", false);
    expect(screen.queryByRole("button", { name: "one" })).toBeNull();
    expect(screen.getByRole("button", { name: "three" })).toHaveAttribute(
      "data-stop",
      "1",
    );
    expect(body().scrollTop).toBe(1990);
    moveTo(11.1);
    expect(body().scrollTop).toBe(1990);
    expect(back()).toBeVisible();
  });

  it("uses the pixel fallback when a removed word lets another word reuse its fallback key", () => {
    const size = viewport("phone");
    const original = Array.from({ length: 30 }, (_, index) => ({
      text: `word-${String(index + 1).padStart(2, "0")}`,
      start: index,
      end: index + 0.5,
      timeline_start: 10 + index,
      timeline_end: 10.5 + index,
    }));
    const hydrated = () =>
      minimalProject({
        transcript: {
          utterances: [
            {
              track_id: "t1",
              source_id: "s1",
              speaker: "Maya",
              start: 0,
              end: 30,
              text: original.map((word) => word.text).join(" "),
              words: original.map((word) => ({ ...word })),
            },
          ],
        },
        timeline_duration_sec: 60,
      });
    useDawStore
      .getState()
      .hydrate("share:follow", hydrated(), "view", ["view", "play"]);
    useDawStore.setState({ stage: "review", playheadSec: 10.1 });
    render(<ReviewHost guestShare />);
    wordSpacing = 100;
    const reader = body();
    scrollManually(reader, 1090);
    expect(back()).toBeVisible();
    expect(
      screen.getByRole("button", { name: "word-11" }).getBoundingClientRect()
        .top,
    ).toBe(10);

    size.short("layout", true);
    const changed = hydrated();
    const utterance = changed.transcript!.utterances[0];
    utterance.words!.splice(0, 1);
    utterance.text = utterance.words!.map((word) => word.text).join(" ");
    wordSpacing = 120;
    act(() => {
      useDawStore
        .getState()
        .hydrate("share:follow", changed, "view", ["view", "play"]);
    });
    size.short("layout", false);

    expect(body().scrollTop).toBe(1090);
    expect(
      screen.getByRole("button", { name: "word-11" }).getBoundingClientRect()
        .top,
    ).toBe(110);
    expect(
      screen.getByRole("button", { name: "word-12" }).getBoundingClientRect()
        .top,
    ).toBe(230);
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
