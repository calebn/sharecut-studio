import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { minimalProject } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import type { CombinedUtterance } from "../../types/project";
import { GuestScriptHost } from "./GuestScriptHost";

const seekTransport = vi.hoisted(() => vi.fn());
vi.mock("../../commands/seek", () => ({ seekTransport }));

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

function as(mode: "view" | "comment" | "edit" | null, playheadSec: number) {
  useDawStore
    .getState()
    .hydrate(
      "share:abc",
      minimalProject({ transcript: { utterances: UTTERANCES } }),
    );
  useDawStore.setState({ guestMode: mode, playheadSec });
}

beforeEach(() => {
  stubViewportShell("desktop");
  seekTransport.mockClear();
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
});
