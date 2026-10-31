import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";

vi.mock("../../services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/offlineQueue/offlineStore")
  >()),
  loadHostCommandQueue: async () => [],
  loadHostAttention: async () => ({ pending: 0, conflicts: [] }),
}));

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  exportTranscript: vi.fn(),
  listExportedTranscripts: vi.fn(),
}));

import { clearRegisteredCommands, execute } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { FeaturesContext } from "../../extensions/FeaturesContext";
import { useDawStore } from "../../state/dawStore";
import {
  BOUNCE_FINISHED,
  EXPORT_FINISHED,
  fakeExportServer,
} from "../../test/fakeExportServer";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { BounceFlowProvider } from "./bounceFlow";
import { DeliverStage } from "./DeliverStage";
import { ExportFlowProvider } from "./exportFlow";
import { ShareFlowProvider } from "./shareFlow";

const PATH = "/tmp/ep/episode.sharecut";

const dryRun = {
  language: "en",
  turns: 1,
  duration_sec: 3,
  preview: [{ speaker: "Maya", start_sec: 0, text: "Hello there." }],
  cue_sample: null,
  files: [],
  text: null,
};

function Host() {
  return (
    <FeaturesContext.Provider
      value={{ ready: true, manifest: { api_version: 1, features: [] } }}
    >
      <ExportFlowProvider>
        <BounceFlowProvider>
          <ShareFlowProvider>
            <DeliverStage />
          </ShareFlowProvider>
        </BounceFlowProvider>
      </ExportFlowProvider>
    </FeaturesContext.Provider>
  );
}

function asHost(withTranscript: boolean) {
  const project = minimalProject({ tracks: [sampleTrack()] });
  useDawStore.getState().hydrate(PATH, {
    ...project,
    transcript: withTranscript
      ? ({ language: "en", words: [] } as unknown as typeof project.transcript)
      : null,
  });
  useDawStore.setState({ stage: "deliver", guestMode: null });
}

let server: ReturnType<typeof fakeExportServer>;

const RUNNING = "An export is running. It writes the transcript too.";

beforeEach(() => {
  server = fakeExportServer();
  stubViewportShell("desktop");
  clearRegisteredCommands();
  registerDawCommands();
  vi.mocked(api.exportTranscript).mockReset().mockResolvedValue(dryRun);
  vi.mocked(api.listExportedTranscripts).mockReset().mockResolvedValue([]);
});

describe("Transcript on the Deliver stage", () => {
  it("previews the edited transcript and the palette command focuses Export", async () => {
    asHost(true);
    render(<Host />);
    expect(await screen.findByText("Hello there.")).toBeVisible();
    act(() => {
      void execute("export.transcript", {}, { skipWhen: true });
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Export 2 files" }),
      ).toHaveFocus(),
    );
    expect(useDawStore.getState().chrome.transcriptRequested).toBe(false);
  });

  it("sends a project without a transcript to Prepare", async () => {
    asHost(false);
    render(<Host />);
    expect(await screen.findByText("Transcribe first")).toBeVisible();
    expect(api.exportTranscript).not.toHaveBeenCalled();
  });

  it("clears a pending request when Deliver unmounts", async () => {
    asHost(true);
    const view = render(<Host />);
    await screen.findByText("Hello there.");
    act(() => useDawStore.getState().setTranscriptRequested(true));
    view.unmount();
    await waitFor(() =>
      expect(useDawStore.getState().chrome.transcriptRequested).toBe(false),
    );
  });

  it("points the Episode file note at the Transcript chips once they show", async () => {
    asHost(true);
    render(<Host />);
    await screen.findByText("Hello there.");
    expect(
      screen.getByText(
        "The transcript is written with every export. Choose more files in Transcript below.",
      ),
    ).toBeVisible();
  });

  it("drops the Episode file note when nothing is transcribed", async () => {
    asHost(false);
    render(<Host />);
    await screen.findByText("Transcribe first");
    expect(
      screen.queryByText(/Choose more files in Transcript below/),
    ).toBeNull();
    expect(screen.queryByText(/written with every export/)).toBeNull();
  });

  it("lists the exported transcript files again when an audio export finishes", async () => {
    asHost(true);
    render(<Host />);
    await screen.findByText("Hello there.");
    await waitFor(() =>
      expect(api.listExportedTranscripts).toHaveBeenCalledTimes(1),
    );
    await userEvent.click(screen.getAllByRole("button", { name: "Export" })[0]);
    await waitFor(() => expect(server.exportRequests).toHaveLength(1));
    await act(async () => server.settle(EXPORT_FINISHED));
    await waitFor(() =>
      expect(api.listExportedTranscripts).toHaveBeenCalledTimes(2),
    );
  });

  it("blocks Transcript Export while an audio export runs", async () => {
    asHost(true);
    render(<Host />);
    await screen.findByText("Hello there.");
    await userEvent.click(screen.getAllByRole("button", { name: "Export" })[0]);
    await waitFor(() => expect(server.exportRequests).toHaveLength(1));
    expect((await screen.findAllByText(RUNNING)).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Export 2 files" }),
    ).toBeDisabled();
  });

  it("blocks Transcript Export while a bounce runs and leaves its files alone when it finishes", async () => {
    asHost(true);
    render(<Host />);
    await screen.findByText("Hello there.");
    await waitFor(() =>
      expect(api.listExportedTranscripts).toHaveBeenCalledTimes(1),
    );
    await userEvent.click(screen.getByRole("button", { name: "Bounce" }));
    await waitFor(() => expect(server.bounceRequests).toHaveLength(1));
    expect((await screen.findAllByText(RUNNING)).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Export 2 files" }),
    ).toBeDisabled();
    await act(async () => server.settle(BOUNCE_FINISHED));
    await screen.findByText("Bounced 1 file(s) to export/bounces/");
    expect(api.listExportedTranscripts).toHaveBeenCalledTimes(1);
  });
});
