import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/offlineQueue/offlineStore")
  >()),
  loadHostCommandQueue: async () => [],
  loadHostAttention: async () => ({ pending: 0, conflicts: [] }),
}));

import { clearRegisteredCommands, execute } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import {
  BOUNCE_FINISHED,
  BOUNCE_STARTED,
  EXPORT_MODEL_NEEDED,
  fakeExportServer,
} from "../../test/fakeExportServer";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import {
  modelStatus,
  registryRows,
  renderWithModels,
} from "../../test/renderWithModels";
import { stubViewportShell } from "../../test/viewportShell";
import type { ExactRangeTarget } from "../../types/project";
import { BounceFlowProvider } from "./bounceFlow";
import { DeliverStage } from "./DeliverStage";
import { ExportFlowProvider } from "./exportFlow";
import { ShareFlowProvider } from "./shareFlow";

const PATH = "/tmp/ep/episode.sharecut";
const OTHER = "/tmp/other/episode.sharecut";

const RANGE = {
  kind: "exact_range",
  intervals: [{ start: 1, end: 2.5 }],
  track_ids: ["t1"],
  clips: [],
} as unknown as ExactRangeTarget;

let server: ReturnType<typeof fakeExportServer>;

function Stages() {
  const stage = useDawStore((s) => s.stage);
  return stage === "deliver" ? <DeliverStage /> : <p>another stage</p>;
}

function Host() {
  return (
    <ExportFlowProvider>
      <BounceFlowProvider>
        <ShareFlowProvider>
          <Stages />
        </ShareFlowProvider>
      </BounceFlowProvider>
    </ExportFlowProvider>
  );
}

const bounceButton = () => screen.getByRole("button", { name: "Bounce" });

async function pressBounce() {
  await userEvent.click(bounceButton());
  await waitFor(() => expect(server.bounceRequests).toHaveLength(1));
}

function asHost(path = PATH) {
  useDawStore
    .getState()
    .hydrate(path, minimalProject({ tracks: [sampleTrack()] }));
  useDawStore.setState({ stage: "deliver", guestMode: null });
}

beforeEach(() => {
  server = fakeExportServer();
  stubViewportShell("desktop");
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.setState({
    activityJob: null,
    pendingJobResults: {},
    selection: null,
    soloTracks: {},
    sessionRegion: null,
    bounceRangeTarget: null,
  });
  asHost();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Bounce on the Deliver stage", () => {
  it("shows the Bounce section with the project's counts and no dialog button", () => {
    useDawStore.setState({
      selection: { kind: "track", trackId: "t1", trackIds: ["t1"] },
      soloTracks: { t1: true, t2: true },
    });
    render(<Host />);
    expect(screen.getByRole("heading", { name: "Bounce" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Selected tracks (1)" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Soloed tracks (2)" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Bounce…" })).toBeNull();
  });

  it("bounces the entire mix as WAV and lists what it wrote", async () => {
    render(<Host />);
    await pressBounce();
    expect(server.bounceRequests[0]).toEqual({
      path: PATH,
      track_ids: null,
      start_s: null,
      end_s: null,
      formats: ["wav"],
    });
    expect(await screen.findByText("Bouncing")).toBeVisible();
    expect(bounceButton()).toBeDisabled();
    await act(async () => server.settle(BOUNCE_FINISHED));
    expect(
      await screen.findByText("Bounced 1 file(s) to export/bounces/"),
    ).toBeVisible();
    expect(screen.getByText("ep.wav")).toBeVisible();
    expect(useDawStore.getState().pendingJobResults).toEqual({
      b1: "Bounced 1 file(s) to export/bounces/",
    });
  });

  it("writes an MP3 beside the WAV and limits to the session region", async () => {
    useDawStore.setState({ sessionRegion: { start_sec: 5, end_sec: 9 } });
    render(<Host />);
    await userEvent.click(
      screen.getByRole("button", { name: "Limit to session region" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Also write MP3" }),
    );
    await pressBounce();
    expect(server.bounceRequests[0]).toMatchObject({
      start_s: 5,
      end_s: 9,
      formats: ["wav", "mp3"],
    });
  });

  it("explains why Bounce waits for tracks, then sends the soloed ones", async () => {
    render(<Host />);
    await userEvent.click(
      screen.getByRole("button", { name: "Soloed tracks (0)" }),
    );
    expect(bounceButton()).toBeDisabled();
    expect(screen.getByText("Solo one or more tracks first.")).toBeVisible();
    act(() => useDawStore.setState({ soloTracks: { t1: true } }));
    await pressBounce();
    expect(server.bounceRequests[0]).toMatchObject({ track_ids: ["t1"] });
  });

  it("keeps running when the stage is left and shows the outcome on return", async () => {
    render(<Host />);
    await pressBounce();
    act(() => useDawStore.setState({ stage: "edit" }));
    await act(async () => server.settle(BOUNCE_FINISHED));
    act(() => useDawStore.setState({ stage: "deliver" }));
    expect(
      await screen.findByText("Bounced 1 file(s) to export/bounces/"),
    ).toBeVisible();
  });

  it("posts the job id when Cancel is pressed, then says nothing was written", async () => {
    render(<Host />);
    await pressBounce();
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toBeEnabled());
    await userEvent.click(cancel);
    await waitFor(() =>
      expect(server.cancelRequests).toEqual([{ job_id: "b1" }]),
    );
    await act(async () =>
      server.settle({ ...BOUNCE_STARTED, status: "cancelled" }),
    );
    expect(
      await screen.findByText(
        "Bounce cancelled. Files from an earlier bounce are unchanged.",
      ),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Bounce again" }));
    expect(screen.queryByText("Bounce cancelled")).toBeNull();
  });

  it("says Bounce failed with the cause, and Try again goes back to Bounce", async () => {
    render(<Host />);
    await pressBounce();
    await act(async () =>
      server.settle({
        ...BOUNCE_STARTED,
        status: "error",
        error: "ffmpeg exited 1",
      }),
    );
    expect(await screen.findByText("Bounce failed")).toBeVisible();
    expect(screen.getByText("ffmpeg exited 1")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.queryByText("Bounce failed")).toBeNull();
    expect(bounceButton()).toBeEnabled();
  });

  it("shows a start failure from the server", async () => {
    server.bounceAnswer = { status: 409, body: { detail: "A job is running" } };
    render(<Host />);
    await userEvent.click(bounceButton());
    expect(await screen.findByText("Bounce failed")).toBeVisible();
  });

  it("asks before downloading a missing model, in the page", async () => {
    renderWithModels(<Host />, { status: modelStatus(registryRows()) });
    await pressBounce();
    await act(async () =>
      server.settle({ ...EXPORT_MODEL_NEEDED, id: "b1", kind: "bounce" }),
    );
    expect(
      await screen.findByText(/Noise reduction \(RNNoise\)/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Download" })).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stops following a running bounce when the project switches", async () => {
    render(<Host />);
    await pressBounce();
    expect(await screen.findByText("Bouncing")).toBeVisible();
    act(() => asHost(OTHER));
    await waitFor(() => expect(screen.queryByText("Bouncing")).toBeNull());
    expect(bounceButton()).toBeEnabled();
    await act(async () => server.settle(BOUNCE_FINISHED));
    expect(screen.queryByText(/Bounced 1 file/)).toBeNull();
  });

  it("shows the command's reason on a disabled Bounce", () => {
    asHost("share:abc");
    render(<Host />);
    expect(bounceButton()).toBeDisabled();
    expect(bounceButton()).toHaveAttribute(
      "title",
      "Host-only (not available on review links)",
    );
  });
});

describe("a range bounced from Edit", () => {
  it("fixes the bounce to the range and lets it go", async () => {
    useDawStore.setState({ bounceRangeTarget: RANGE });
    render(<Host />);
    expect(
      screen.getByText(
        "Selected range · 1.00–2.50 s on t1. This selection is fixed for this bounce.",
      ),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Bounce the whole mix instead" }),
    );
    expect(useDawStore.getState().bounceRangeTarget).toBeNull();
    expect(screen.getByRole("group", { name: "Source" })).toBeVisible();
  });

  it("sends the exact range and clears it once the bounce is done", async () => {
    useDawStore.setState({ bounceRangeTarget: RANGE });
    render(<Host />);
    await pressBounce();
    expect(server.bounceRequests[0]).toEqual({
      path: PATH,
      track_ids: null,
      start_s: null,
      end_s: null,
      formats: ["wav"],
      exact_range: RANGE,
    });
    expect(useDawStore.getState().bounceRangeTarget).toEqual(RANGE);
    await act(async () => server.settle(BOUNCE_FINISHED));
    await screen.findByText("Bounced 1 file(s) to export/bounces/");
    expect(useDawStore.getState().bounceRangeTarget).toBeNull();
  });

  it("keeps the range after a failed bounce so Try again bounces it", async () => {
    useDawStore.setState({ bounceRangeTarget: RANGE });
    render(<Host />);
    await pressBounce();
    await act(async () =>
      server.settle({ ...BOUNCE_STARTED, status: "error", error: "no" }),
    );
    await screen.findByText("Bounce failed");
    expect(useDawStore.getState().bounceRangeTarget).toEqual(RANGE);
  });
});

describe("the bounce command", () => {
  it("goes to Deliver, focuses Bounce and starts nothing", async () => {
    useDawStore.setState({ stage: "edit", bounceRangeTarget: RANGE });
    render(<Host />);
    expect(await execute("export.bounce", {})).toEqual({ status: "ok" });
    expect(useDawStore.getState().stage).toBe("deliver");
    await waitFor(() => expect(bounceButton()).toHaveFocus());
    expect(useDawStore.getState().chrome.bounceRequested).toBe(false);
    expect(useDawStore.getState().bounceRangeTarget).toBeNull();
    expect(server.bounceRequests).toEqual([]);
  });

  it("is refused on a review link", async () => {
    asHost("share:abc");
    const result = await execute("export.bounce", {});
    expect(result.status).toBe("disabled");
    expect(useDawStore.getState().chrome.bounceRequested).toBe(false);
  });
});
