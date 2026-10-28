import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { CENTER, NEAREST, probeScript } from "../../system/scriptScrollProbe";
import { minimalProject } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import type { CombinedUtterance } from "../../types/project";
import { GuestScriptHost } from "./GuestScriptHost";

const seekTransport = vi.hoisted(() => vi.fn());
vi.mock("../../commands/seek", () => ({ seekTransport }));
const scriptRenders = vi.hoisted(() => vi.fn());
vi.mock("../../stages/guest/GuestScript", async (original) => {
  const actual =
    await original<typeof import("../../stages/guest/GuestScript")>();
  return {
    GuestScript: (props: Parameters<typeof actual.GuestScript>[0]) => {
      scriptRenders();
      return actual.GuestScript(props);
    },
  };
});

const UTTERANCES: CombinedUtterance[] = [
  {
    track_id: "t1",
    source_id: "s1",
    speaker: "Maya",
    start: 0,
    end: 0,
    text: "",
    words: [
      {
        text: "Welcome",
        start: 0,
        end: 0,
        timeline_start: 10,
        timeline_end: 10.5,
      },
      {
        text: "back",
        start: 0,
        end: 0,
        timeline_start: 11,
        timeline_end: 11.5,
      },
      { text: "cut", start: 0, end: 0, timeline_start: 12, suppressed: true },
    ],
  },
];

function as(
  mode: "view" | "comment" | "edit" | null,
  playheadSec: number,
  utterances: CombinedUtterance[] = UTTERANCES,
) {
  useDawStore
    .getState()
    .hydrate("share:abc", minimalProject({ transcript: { utterances } }));
  useDawStore.setState({ guestMode: mode, playheadSec });
}

beforeEach(() => {
  stubViewportShell("desktop");
  seekTransport.mockClear();
  scriptRenders.mockClear();
});

describe("GuestScriptHost", () => {
  it("shows nothing to the host", () => {
    as(null, 0);
    const { container } = render(<GuestScriptHost />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["view", "Read only"],
    ["comment", "Read only · you can comment"],
    ["edit", "Read only · you can comment"],
  ] as const)("a %s link reads the heard words, labelled %j", (mode, label) => {
    as(mode, 0);
    render(<GuestScriptHost />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Welcome" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "back" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "cut" })).toBeNull();
  });

  it.each([
    [9, null],
    [10, "Welcome"],
    [11.2, "back"],
  ])("the playhead at %s marks %j", (playheadSec, playing) => {
    as("view", playheadSec);
    render(<GuestScriptHost />);
    expect(
      document.querySelector(".sys-script-word[data-playing]")?.textContent ??
        null,
    ).toBe(playing);
  });

  it("seeks the transport to the clicked word's start", async () => {
    as("comment", 0);
    render(<GuestScriptHost />);
    await userEvent.click(screen.getByRole("button", { name: "back" }));
    expect(seekTransport).toHaveBeenCalledExactlyOnceWith(11);
  });

  it("says so when there is no transcript", () => {
    useDawStore.getState().hydrate("share:abc", minimalProject());
    useDawStore.setState({ guestMode: "view" });
    render(<GuestScriptHost />);
    expect(
      screen.getByRole("heading", { name: "Nothing to read yet" }),
    ).toBeInTheDocument();
  });

  it("says every word was cut when the transcript has no heard words", () => {
    as("view", 0, [
      {
        ...UTTERANCES[0],
        words: [{ text: "cut", start: 0, end: 0, suppressed: true }],
      } as CombinedUtterance,
    ]);
    render(<GuestScriptHost />);
    expect(
      screen.getByText("Every word of this version has been cut or ignored."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("The host has not made a transcript of this version."),
    ).toBeNull();
  });

  it("says the host made no transcript for an empty one", () => {
    as("view", 0, []);
    render(<GuestScriptHost />);
    expect(
      screen.getByText("The host has not made a transcript of this version."),
    ).toBeInTheDocument();
  });

  describe("overlapping speech", () => {
    const word = (text: string, at: number) => ({
      text,
      start: 0,
      end: 0,
      timeline_start: at,
      timeline_end: at + 1,
    });
    const OVERLAP: CombinedUtterance[] = [
      { ...UTTERANCES[0], words: [word("one", 10), word("two", 14)] },
      {
        ...UTTERANCES[0],
        track_id: "t2",
        speaker: "Anneke",
        words: [word("over", 12)],
      } as CombinedUtterance,
    ];

    it("marks the overlapped word while it is spoken", () => {
      as("view", 12.5, OVERLAP);
      render(<GuestScriptHost />);
      expect(
        [...document.querySelectorAll(".sys-script-word[data-playing]")].map(
          (el) => el.textContent,
        ),
      ).toEqual(["over"]);
    });

    it("marks both words when two tracks speak at once", () => {
      as("view", 10.5, [
        ...OVERLAP,
        {
          ...OVERLAP[1],
          track_id: "t3",
          words: [word("with", 10.2)],
        } as CombinedUtterance,
      ]);
      render(<GuestScriptHost />);
      expect(
        [...document.querySelectorAll(".sys-script-word[data-playing]")].map(
          (el) => el.textContent,
        ),
      ).toEqual(["one", "with"]);
    });

    it("seeks to the overlapped word's own start", async () => {
      as("comment", 0, OVERLAP);
      render(<GuestScriptHost />);
      await userEvent.click(screen.getByRole("button", { name: "over" }));
      expect(seekTransport).toHaveBeenCalledExactlyOnceWith(12);
    });
  });

  it("wraps speaker colours after eight", () => {
    as(
      "view",
      0,
      Array.from({ length: 9 }, (_, i) => ({
        ...UTTERANCES[0],
        track_id: `t${i}`,
        speaker: `S${i}`,
        words: [
          {
            text: `w${i}`,
            start: 0,
            end: 0,
            timeline_start: i,
            timeline_end: i,
          },
        ],
      })) as CombinedUtterance[],
    );
    const { container } = render(<GuestScriptHost />);
    const colors = [...container.querySelectorAll<HTMLElement>("[style]")]
      .map((el) => el.style.getPropertyValue("--sys-person-color"))
      .filter(Boolean);
    expect(colors).toContain("var(--color-presence-7)");
    expect(colors.at(-1)).toBe("var(--color-presence-0)");
  });

  it("re-renders only when the playing word changes", () => {
    as("view", 10.1);
    render(<GuestScriptHost />);
    const before = scriptRenders.mock.calls.length;
    act(() => useDawStore.setState({ playheadSec: 10.3 }));
    expect(scriptRenders).toHaveBeenCalledTimes(before);
    act(() => useDawStore.setState({ playheadSec: 11.1 }));
    expect(scriptRenders.mock.calls.length).toBeGreaterThan(before);
  });

  it("stops following on scroll and Back to playhead follows again", async () => {
    as("view", 11.2);
    render(<GuestScriptHost />);
    const body = document.querySelector(".sys-script-body") as HTMLElement;
    const probe = probeScript(body);
    fireEvent.wheel(body);
    fireEvent.scroll(body);
    probe.clear();
    await userEvent.click(
      screen.getByRole("button", { name: /Back to playhead/ }),
    );
    expect(probe.calls[0]?.[1]).toBe(CENTER);
    probe.restore();
    expect(
      screen.queryByRole("button", { name: /Back to playhead/ }),
    ).toBeNull();
  });

  describe("following playback", () => {
    let probe: ReturnType<typeof probeScript>;
    const scrolledTo = () => probe.calls;
    const scrollAway = () => {
      const body = document.querySelector(".sys-script-body") as HTMLElement;
      fireEvent.wheel(body);
      fireEvent.scroll(body);
    };
    const moveTo = (playheadSec: number) =>
      act(() => useDawStore.setState({ playheadSec }));

    const mount = () => {
      render(<GuestScriptHost />);
      probe = probeScript(
        document.querySelector(".sys-script-body") as HTMLElement,
      );
    };
    afterEach(() => probe?.restore());

    it("scrolls to the playing word when it changes", () => {
      as("view", 10.1);
      mount();
      probe.clear();
      moveTo(11.2);
      expect(scrolledTo()).toEqual([["back", NEAREST]]);
    });

    it("does not scroll once the guest scrolls away", () => {
      as("view", 10.1);
      mount();
      scrollAway();
      probe.clear();
      moveTo(11.2);
      expect(scrolledTo()).toEqual([]);
    });

    it("scrolls again after Back to playhead", async () => {
      as("view", 10.1);
      mount();
      scrollAway();
      await userEvent.click(
        screen.getByRole("button", { name: /Back to playhead/ }),
      );
      probe.clear();
      moveTo(11.2);
      expect(scrolledTo()).toEqual([["back", NEAREST]]);
    });

    it("offers Back to playhead in a pause and targets the last heard word", async () => {
      as("view", 10.1);
      mount();
      scrollAway();
      moveTo(10.8);
      probe.clear();
      await userEvent.click(
        screen.getByRole("button", { name: /Back to playhead/ }),
      );
      expect(scrolledTo()[0]).toEqual(["Welcome", CENTER]);
      expect(
        document.querySelector(".sys-script-word[data-playing]"),
      ).toBeNull();
    });
  });
});
