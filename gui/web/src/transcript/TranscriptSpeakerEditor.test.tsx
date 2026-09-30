import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setTrackMetaCommand } from "../api";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { resetDocumentSeqForTests } from "../document/cursor";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { TranscriptSpeakerEditor } from "./TranscriptSpeakerEditor";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  setTrackMetaCommand: vi.fn(async () => ({})),
}));
const track = sampleTrack({ speaker: "Host", label: "Host mic" });

function open() {
  const onClose = vi.fn();
  const view = render(
    <main>
      <TranscriptSpeakerEditor
        track={track}
        speaker="Host"
        speakers={["Guest"]}
        onClose={onClose}
        onBusyChange={vi.fn()}
      />
    </main>,
  );
  return { ...view, onClose };
}

describe("TranscriptSpeakerEditor", () => {
  beforeEach(() => {
    resetDocumentSeqForTests();
    vi.mocked(setTrackMetaCommand).mockReset().mockResolvedValue({});
    useDawStore.setState({
      projectPath: "/tmp/ep",
      project: minimalProject({
        tracks: [track],
        transcript: {
          utterances: [
            {
              track_id: "host",
              speaker: "Host",
              text: "hello",
              start: 0,
              end: 1,
            },
            {
              track_id: "guest",
              speaker: "Guest",
              text: "hi",
              start: 1,
              end: 2,
            },
          ],
        },
      }),
    });
  });
  it("focuses the name, explains scope, offers existing speakers, and saves through SetTrackMeta", async () => {
    const { container, onClose } = open();
    const input = screen.getByRole("combobox", { name: "Speaker name" });
    expect(input).toHaveFocus();
    expect(input).toHaveAccessibleDescription("All turns on Host mic.");
    expect(container.querySelector('option[value="Guest"]')).not.toBeNull();
    await expectNoA11yViolations(container);
    fireEvent.change(input, { target: { value: " Guest " } });
    fireEvent.click(screen.getByRole("button", { name: "Save speaker" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(setTrackMetaCommand).toHaveBeenCalledExactlyOnceWith(
      "/tmp/ep",
      "host",
      { speaker: "Guest" },
    );
    expect(useDawStore.getState().project?.tracks[0].speaker).toBe("Guest");
  });
  it("cancels on Escape without writing", () => {
    const { onClose } = open();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(setTrackMetaCommand).not.toHaveBeenCalled();
  });
  it("rejects empty names and skips unchanged names", async () => {
    const { onClose } = open();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: "Save speaker" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a speaker name.",
    );
    expect(setTrackMetaCommand).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "Host" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save speaker" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("keeps the draft and restores track metadata when the command fails", async () => {
    vi.mocked(setTrackMetaCommand).mockRejectedValue(
      new Error("Could not save speaker"),
    );
    const { onClose } = open();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "Mira" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save speaker" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save speaker",
    );
    expect(screen.getByRole("combobox")).toHaveValue("Mira");
    expect(useDawStore.getState().project?.tracks[0].speaker).toBe("Host");
    expect(onClose).not.toHaveBeenCalled();
  });
  it("keeps queued speaker saves visible in transcript rows", async () => {
    vi.mocked(setTrackMetaCommand).mockResolvedValue({
      ok: true,
      queued: true,
    });
    const { onClose } = open();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "Mira" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save speaker" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Track metadata change queued. Still sending.",
    );
    expect(
      useDawStore
        .getState()
        .project?.transcript?.utterances.map((row) => row.speaker),
    ).toEqual(["Mira", "Guest"]);
  });
  it.each(["project switch", "sequenced peer", "unsequenced peer"])(
    "keeps %s state after a pending save is rejected",
    async (update) => {
      let rejectSave!: (error: Error) => void;
      vi.mocked(setTrackMetaCommand).mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectSave = reject;
          }),
      );
      open();
      fireEvent.change(screen.getByRole("combobox"), {
        target: { value: "Mira" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save speaker" }));
      const peer = minimalProject({
        tracks: [sampleTrack({ speaker: "Peer" })],
      });
      if (update === "project switch") {
        useDawStore.getState().hydrate("/tmp/other", peer);
        resetDocumentSeqForTests();
      } else {
        applyDocumentSnapshot(
          {
            project: peer,
            server_seq: update === "sequenced peer" ? 4 : undefined,
          },
          { force: true },
        );
      }
      const expected = useDawStore.getState().project;
      rejectSave(new Error("Rejected save"));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Rejected save",
      );
      expect(useDawStore.getState().project).toBe(expected);
      expect(useDawStore.getState().projectPath).toBe(
        update === "project switch" ? "/tmp/other" : "/tmp/ep",
      );
    },
  );
});
