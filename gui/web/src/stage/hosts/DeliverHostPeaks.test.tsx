import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { commandLocks } from "../../test/commandLocks";
import { fakeExportServer } from "../../test/fakeExportServer";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { DeliverStage as HostDeliverStage } from "./DeliverStage";
import { ExportFlowProvider } from "./exportFlow";
import { ShareFlowProvider } from "./shareFlow";

const PATH = "/tmp/deliver-host-peaks/episode.sharecut";

const STEM = {
  status: "ready",
  key: "stemkey",
  sample_rate: 10,
  channels: 1,
  total_frames: 6000,
  base_spp: 10,
  level_factor: 4,
  bins_per_tile: 4096,
  levels: [{ spp: 10, bins: 600 }],
};

function serveStem() {
  const fallback = fetch;
  const bins = Int16Array.from(
    { length: 600 * 3 },
    (_, i) => (((i / 3) | 0) % 7) * 4000,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/api/waveform/status"))
        return Response.json({ format_version: 1, media: { "stem:t1": STEM } });
      if (url.includes("/api/waveform/tiles/"))
        return new Response(bins.buffer);
      return fallback(input, init);
    }),
  );
}

describe("Deliver host clip trim peaks", () => {
  beforeEach(() => {
    fakeExportServer();
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: commandLocks(),
    });
    sessionStorage.clear();
    stubViewportShell("desktop");
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate(
      PATH,
      minimalProject({
        tracks: [sampleTrack()],
        timeline_duration_sec: 600,
        chapters: [],
        social_clips: [
          {
            id: "s1",
            track_id: "t1",
            start: 10,
            end: 40,
            score: 0.9,
            title_suggestion: "A line",
            approved: false,
            review_required: false,
          },
        ],
      }),
    );
    useDawStore.setState({ stage: "deliver", guestMode: null });
  });

  afterEach(() => vi.unstubAllGlobals());

  const peakCount = async () => {
    render(
      <ExportFlowProvider>
        <ShareFlowProvider>
          <HostDeliverStage />
        </ShareFlowProvider>
      </ExportFlowProvider>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "More for A line" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Trim" }),
    );
    return document.querySelectorAll(".sys-wave-peak").length;
  };

  it("draws the episode waveform in the trim strip", async () => {
    serveStem();
    await peakCount();
    await waitFor(() =>
      expect(
        document.querySelectorAll(".sys-wave-peak").length,
      ).toBeGreaterThan(1),
    );
  });

  it("draws a flat line when no stem is built", async () => {
    expect(await peakCount()).toBe(1);
  });
});
