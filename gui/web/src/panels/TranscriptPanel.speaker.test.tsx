import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { TranscriptPanel } from "./TranscriptPanel";

describe("Transcript speaker control", () => {
  beforeEach(() => {
    useDawStore.setState({
      projectPath: "/tmp/ep",
      guestMode: null,
      shareCapabilities: null,
      project: minimalProject({
        tracks: [sampleTrack({ speaker: "Host" })],
        transcript: {
          utterances: [
            {
              track_id: "host",
              speaker: "Host",
              start: 2,
              end: 3,
              text: "hello",
              timeline_start: 2,
              timeline_end: 3,
              mappable: true,
            },
          ],
        },
      }),
      selection: null,
      playheadSec: 0,
      transcriptFollowPlayhead: false,
    });
  });
  it("opens speaker editing independently of seeking", () => {
    render(<TranscriptPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Change speaker Host" }),
    );
    expect(
      screen.getByRole("combobox", { name: "Speaker name" }),
    ).toHaveFocus();
    expect(useDawStore.getState().playheadSec).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("combobox")).toBeNull();
  });
  it.each([null, ["view"], ["suggest"], ["comment"]])(
    "hides mutation for shares with %s",
    (shareCapabilities) => {
      useDawStore.setState({
        projectPath: "share:test",
        guestMode: "edit",
        shareCapabilities,
      });
      render(<TranscriptPanel />);
      expect(
        screen.queryByRole("button", { name: /Change speaker/ }),
      ).toBeNull();
      expect(screen.queryByRole("combobox")).toBeNull();
    },
  );
  it("allows edit capability and closes the editor if that capability is removed", () => {
    useDawStore.setState({
      projectPath: "share:test",
      guestMode: "edit",
      shareCapabilities: ["edit"],
    });
    const { rerender } = render(<TranscriptPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Change speaker Host" }),
    );
    expect(screen.getByRole("combobox")).toBeVisible();
    useDawStore.setState({ shareCapabilities: ["view"] });
    rerender(<TranscriptPanel />);
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
