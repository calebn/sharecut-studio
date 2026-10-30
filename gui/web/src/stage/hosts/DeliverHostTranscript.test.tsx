import { act, render, screen, waitFor } from "@testing-library/react";
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
import { fakeExportServer } from "../../test/fakeExportServer";
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

beforeEach(() => {
  fakeExportServer();
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
});
