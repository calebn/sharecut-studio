import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/offlineQueue/offlineStore")
  >()),
  loadHostCommandQueue: async () => [],
  loadHostAttention: async () => ({ pending: 0, conflicts: [] }),
}));

import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { PENDING } from "../../stages/deliver/feedFixture";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { deferred } from "../../test/deferred";
import {
  EXPORT_FINISHED,
  EXPORT_MODEL_NEEDED,
  EXPORT_STARTED,
  exportEvidence,
  fakeExportServer,
} from "../../test/fakeExportServer";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import {
  modelStatus,
  registryRows,
  renderWithLanding,
} from "../../test/renderWithModels";
import { stubViewportShell } from "../../test/viewportShell";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import { parseHistoryEntryId } from "../../types/project";
import { StatusLive } from "../frame/StatusLive";
import { DeliverStage } from "./DeliverStage";
import { ExportFlowProvider } from "./exportFlow";
import { ShareFlowProvider } from "./shareFlow";

const PATH = "/tmp/ep/episode.sharecut";
const MP3 = { ext: "mp3", codec: "libmp3lame", bitrate_kbps: 128 };

const MASTER = {
  within_tolerance: true,
  measured: { integrated_lufs: -23.1, true_peak_db: -1.6 },
};
const BROADCAST_RESULT = {
  file_ids: ["opaque:b?2", "opaque:a#1"],
  target: "broadcast",
  applied_settings: exportEvidence("broadcast"),
  master: MASTER,
  edit_head_id: null,
};
const ENTRIES = [
  {
    id: "canonical.mp3",
    name: "episode.mp3",
    kind: "audio",
    label: "Canonical",
    bytes: 64,
    current: true,
  },
  {
    id: "different-variant",
    name: "episode-broadcast.mp3",
    kind: "audio",
    label: "Broadcast",
    bytes: 64,
    current: true,
  },
  {
    id: "opaque:a#1",
    name: "episode-broadcast.mp3",
    kind: "audio",
    label: "Broadcast",
    bytes: 64,
    current: true,
    ticket: "mp3-ticket",
  },
  {
    id: "opaque:b?2",
    name: "episode-broadcast.wav",
    kind: "audio",
    label: "Broadcast",
    bytes: 64,
    current: true,
    ticket: "wav-ticket",
  },
] satisfies ReturnType<typeof fakeExportServer>["files"];

let server: ReturnType<typeof fakeExportServer>;

function Stages() {
  const stage = useDawStore((state) => state.stage);
  return stage === "deliver" ? <DeliverStage /> : <p>another stage</p>;
}

function Host() {
  return (
    <ExportFlowProvider>
      <ShareFlowProvider>
        <Stages />
      </ShareFlowProvider>
    </ExportFlowProvider>
  );
}

function revisitDeliver() {
  act(() => useDawStore.setState({ stage: "edit" }));
  act(() => useDawStore.setState({ stage: "deliver" }));
}

const FEED_WITHOUT_AUDIO = {
  ...PENDING,
  findings: [
    {
      key: null,
      severity: "blocker",
      platform: "Apple",
      message: "Export the episode to supply the audio.",
      fix: { kind: "command", command: "export_episode" },
    },
  ],
} satisfies ReturnType<typeof fakeExportServer>["feed"];

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
    jobFeedback: new Map(),
    spokenJobResultIds: [],
  });
  asHost();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function exportReady() {
  const button = await screen.findByRole("button", { name: "Export" });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

function choice(name: string | RegExp) {
  return within(screen.getByRole("group", { name: "Loudness" })).getByRole(
    "button",
    { name },
  );
}

async function startBroadcast() {
  const button = await exportReady();
  await userEvent.click(choice(/^Broadcast/));
  await userEvent.click(button);
  await waitFor(() => expect(server.watchers()).toBe(1));
}

async function finish(
  result: PipelineJobSnapshot["result"] = BROADCAST_RESULT,
  status: PipelineJobSnapshot["status"] = "ok",
) {
  await act(async () => server.settle({ ...server.started, status, result }));
}

describe("host export loudness", () => {
  it("completes the default export without sending a target", async () => {
    render(<Host />);
    const exportButton = await screen.findByRole("button", { name: "Export" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    await userEvent.click(exportButton);
    await waitFor(() => expect(server.exportRequests).toHaveLength(1));

    expect(server.exportRequests[0]).toEqual({
      path: PATH,
      formats: [MP3],
    });

    await act(async () => server.settle(EXPORT_FINISHED));
    expect(await screen.findByText("Exported")).toBeInTheDocument();
  });

  it("marks a completed default export out of date after choosing Broadcast", async () => {
    server.files = [ENTRIES[0]];
    render(<Host />);
    const exportButton = await exportReady();
    await userEvent.click(exportButton);
    await waitFor(() => expect(server.exportRequests).toHaveLength(1));
    await act(async () => server.settle(EXPORT_FINISHED));
    expect(await screen.findByText("Exported")).toBeVisible();
    expect(
      await screen.findByRole("link", { name: "Download episode.mp3, 64 B" }),
    ).toHaveAttribute(
      "href",
      "/api/export/files/canonical.mp3?path=%2Ftmp%2Fep%2Fepisode.sharecut",
    );

    await userEvent.click(choice(/^Broadcast/));

    expect(choice(/^Broadcast/)).toHaveAttribute("aria-pressed", "true");
    expect.soft(screen.queryByText("Export is out of date")).toBeVisible();
    expect
      .soft(screen.queryByText("Edited since export"))
      .not.toBeInTheDocument();

    await userEvent.click(choice("Project default"));
    expect(choice("Project default")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Exported")).toBeVisible();
    expect(server.exportRequests).toEqual([{ path: PATH, formats: [MP3] }]);
    expect(
      await screen.findByRole("link", { name: "Download episode.mp3, 64 B" }),
    ).toHaveAttribute(
      "href",
      "/api/export/files/canonical.mp3?path=%2Ftmp%2Fep%2Fepisode.sharecut",
    );
  });

  it("keeps an empty canonical paths result distinct from a malformed named receipt", async () => {
    render(<Host />);
    await userEvent.click(await exportReady());
    await waitFor(() => expect(server.watchers()).toBe(1));
    await finish({ paths: [] });
    expect(await screen.findByText("Exported")).toBeVisible();
    expect(useDawStore.getState().jobFeedback).toEqual(
      new Map([
        [
          "x1",
          {
            kind: "ready",
            outcome: { kind: "verified", copy: "Exported 0 files to export/" },
          },
        ],
      ]),
    );
  });

  it("uses the selected target when Export is in the phone dock", async () => {
    stubViewportShell("phone");
    render(<Host />);
    const button = await exportReady();
    await userEvent.click(choice(/^Streaming/));
    await userEvent.click(button);
    await waitFor(() =>
      expect(server.exportRequests).toEqual([
        { path: PATH, formats: [MP3], target: "streaming" },
      ]),
    );
  });

  it("sends the selected Broadcast target with the export", async () => {
    render(<Host />);
    const exportButton = await screen.findByRole("button", { name: "Export" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    const loudness = screen.getByRole("group", { name: "Loudness" });
    await userEvent.click(
      within(loudness).getByRole("button", { name: /^Broadcast\s*−23$/ }),
    );
    await userEvent.click(exportButton);
    await waitFor(() => expect(server.exportRequests).toHaveLength(1));

    expect(server.exportRequests[0]).toEqual({
      path: PATH,
      formats: [MP3],
      target: "broadcast",
    });
  });

  it("submits the configured Broadcast format alias for the producer to resolve", async () => {
    server.config = {
      config: {
        export: {
          wav: true,
          formats: [{ extension: ".MP3", bitrate_kbps: 128 }],
        },
      },
    };
    render(<Host />);
    await startBroadcast();

    expect(server.exportRequests).toEqual([
      {
        path: PATH,
        formats: [{ extension: ".MP3", bitrate_kbps: 128 }],
        target: "broadcast",
      },
    ]);
  });

  it.each([
    { name: "Project default", loudness: "Project default", target: {} },
    {
      name: "Broadcast",
      loudness: /^Broadcast/,
      target: { target: "broadcast" },
    },
  ])(
    "posts the raw empty ext and MP3 alias with $name",
    async ({ loudness, target }) => {
      server.config = {
        config: {
          export: {
            wav: true,
            formats: [{ ext: "", extension: "mp3", bitrate_kbps: 128 }],
          },
        },
      };
      render(<Host />);
      const button = await exportReady();
      const formats = within(screen.getByRole("group", { name: "Formats" }));
      expect
        .soft(
          formats
            .queryByRole("button", { name: /^MP3 · 128 kbps/ })
            ?.getAttribute("aria-pressed"),
        )
        .toBe("true");
      await userEvent.click(choice(loudness));
      await userEvent.click(button);
      await waitFor(() => expect(server.watchers()).toBe(1));

      expect(server.exportRequests).toEqual([
        {
          path: PATH,
          formats: [{ ext: "", extension: "mp3", bitrate_kbps: 128 }],
          ...target,
        },
      ]);
    },
  );

  it.each([
    { name: /^Podcast\s*−16$/, target: "podcast" },
    { name: /^Streaming\s*−14$/, target: "streaming" },
  ])(
    "posts explicit $target even when it matches the project master",
    async ({ name, target }) => {
      render(<Host />);
      const button = await exportReady();
      await userEvent.click(choice(name));
      expect(
        screen.getByText("This export includes audio only."),
      ).toBeVisible();
      await userEvent.click(button);
      await waitFor(() =>
        expect(server.exportRequests).toEqual([
          { path: PATH, formats: [MP3], target },
        ]),
      );
    },
  );

  it("resets to project default and keeps the canonical captions and master copy", async () => {
    const { container } = render(<Host />);
    const button = await exportReady();
    await userEvent.click(choice(/^Broadcast/));
    await userEvent.click(choice("Project default"));
    expect(choice("Project default")).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText(/Project target preview is −16\.0 LUFS/),
    ).toBeVisible();
    expect(screen.getByText(/Available captions and transcript/)).toBeVisible();
    await expectNoA11yViolations(container);
    await userEvent.click(button);
    await waitFor(() =>
      expect(server.exportRequests).toEqual([{ path: PATH, formats: [MP3] }]),
    );
  });

  it("uses canonical export for Feed repair with Broadcast selected", async () => {
    server.feed = FEED_WITHOUT_AUDIO;
    render(<Host />);
    await exportReady();
    await userEvent.click(choice(/^Broadcast/));
    await userEvent.click(
      await screen.findByRole("button", { name: "Export episode" }),
    );
    await waitFor(() =>
      expect(server.exportRequests).toEqual([{ path: PATH, formats: [MP3] }]),
    );
    await act(async () => server.settle(EXPORT_FINISHED));
    expect(await screen.findByText("Exported")).toBeVisible();
    expect(server.settingsRequests.map(({ body }) => body)).toEqual([
      { path: PATH, formats: [MP3] },
    ]);
    expect(choice("Project default")).toHaveAttribute("aria-pressed", "true");
  });

  it.each([
    {
      status: 409,
      code: "export_job_conflict",
      detail: "Another job is already running.",
    },
    {
      status: 400,
      code: "export_request_invalid",
      detail: "The export request was invalid.",
    },
  ])(
    "keeps Broadcast when the server refuses Feed export with $status",
    async ({ status, code, detail }) => {
      server.feed = FEED_WITHOUT_AUDIO;
      server.startAnswer = { status, code, body: { detail } };
      render(<Host />);
      await exportReady();
      await userEvent.click(choice(/^Broadcast/));
      await userEvent.click(
        await screen.findByRole("button", { name: "Export episode" }),
      );

      expect(await screen.findByText(detail, { exact: false })).toBeVisible();
      expect(server.exportRequests).toEqual([{ path: PATH, formats: [MP3] }]);
      expect(server.watchers()).toBe(0);
      expect(choice(/^Broadcast/)).toHaveAttribute("aria-pressed", "true");
    },
  );

  it.each([false, true])(
    "preserves a loudness choice made while Feed admission is pending (ABA: %s)",
    async (restoreBroadcast) => {
      server.feed = FEED_WITHOUT_AUDIO;
      const held = deferred<void>();
      server.holdStart = held.promise;
      render(<Host />);
      await exportReady();
      await userEvent.click(choice(/^Broadcast/));
      await userEvent.click(
        await screen.findByRole("button", { name: "Export episode" }),
      );
      try {
        await waitFor(() =>
          expect(server.exportRequests).toEqual([
            { path: PATH, formats: [MP3] },
          ]),
        );
        expect
          .soft(choice(/^Broadcast/))
          .toHaveAttribute("aria-pressed", "true");
        await userEvent.click(choice(/^Streaming/));
        if (restoreBroadcast) await userEvent.click(choice(/^Broadcast/));
        await act(async () => held.resolve());
        await waitFor(() => expect(server.watchers()).toBe(1));
        expect(
          choice(restoreBroadcast ? /^Broadcast/ : /^Streaming/),
        ).toHaveAttribute("aria-pressed", "true");
      } finally {
        await act(async () => {
          held.resolve();
          server.settle(EXPORT_FINISHED);
        });
      }
    },
  );

  it("publishes Project default after Feed admission across a route revisit", async () => {
    server.feed = FEED_WITHOUT_AUDIO;
    const held = deferred<void>();
    server.holdStart = held.promise;
    render(<Host />);
    try {
      await exportReady();
      await userEvent.click(choice(/^Broadcast/));
      await userEvent.click(
        await screen.findByRole("button", { name: "Export episode" }),
      );
      await waitFor(() =>
        expect(server.exportRequests).toEqual([{ path: PATH, formats: [MP3] }]),
      );
      expect(choice(/^Broadcast/)).toHaveAttribute("aria-pressed", "true");

      const readsBeforeRevisit = server.configRequests.length;
      revisitDeliver();
      await waitFor(() =>
        expect(server.configRequests.length).toBeGreaterThan(
          readsBeforeRevisit,
        ),
      );
      expect(choice(/^Broadcast/)).toHaveAttribute("aria-pressed", "true");
      await act(async () => held.resolve());
      await waitFor(() => expect(server.watchers()).toBe(1));
      expect(await screen.findByText("Exporting")).toBeVisible();
      expect
        .soft(choice("Project default"))
        .toHaveAttribute("aria-pressed", "true");
      expect(server.exportRequests).toEqual([{ path: PATH, formats: [MP3] }]);

      await act(async () => server.settle(EXPORT_FINISHED));
      expect(server.settled).toMatchObject({
        status: "ok",
        result: { paths: ["/tmp/ep/export/ep.wav", "/tmp/ep/export/ep.mp3"] },
      });
      expect
        .soft(screen.getByText("Exported 2 files to export/"))
        .toBeVisible();
      expect(
        screen.getByText("Measured −16.1 LUFS, true peak −1.6 dBTP."),
      ).toBeVisible();
      expect(
        screen.queryByText("Export is out of date"),
      ).not.toBeInTheDocument();
      expect(useDawStore.getState().jobFeedback.get("x1")).toEqual({
        kind: "ready",
        outcome: { kind: "verified", copy: "Exported 2 files to export/" },
      });
      expect(server.exportRequests).toEqual([{ path: PATH, formats: [MP3] }]);
    } finally {
      await act(async () => {
        held.resolve();
        if (server.watchers()) server.settle(EXPORT_FINISHED);
      });
    }
  });

  it("keeps the next loudness choice when an active export refuses Feed repair", async () => {
    server.feed = FEED_WITHOUT_AUDIO;
    const held = deferred<void>();
    server.holdStart = held.promise;
    render(<Host />);
    try {
      const button = await exportReady();
      await userEvent.click(choice(/^Broadcast/));
      await userEvent.click(button);
      const original = [{ path: PATH, formats: [MP3], target: "broadcast" }];
      await waitFor(() => expect(server.exportRequests).toEqual(original));
      expect(screen.getByText("Exporting")).toBeVisible();

      await userEvent.click(choice(/^Streaming/));
      expect(choice(/^Streaming/)).toHaveAttribute("aria-pressed", "true");
      const repair = await screen.findByRole("button", {
        name: "Export episode",
      });
      expect(repair).toBeEnabled();
      await userEvent.click(repair);

      expect(server.exportRequests).toEqual(original);
      expect(choice(/^Streaming/)).toHaveAttribute("aria-pressed", "true");
    } finally {
      await act(async () => {
        held.resolve();
        server.settle(EXPORT_FINISHED);
      });
    }
  });

  it.each(["unchanged", "new choice", "ABA", "format ABA"])(
    "publishes resumed canonical Feed only for the original input owner: %s",
    async (input) => {
      server.feed = FEED_WITHOUT_AUDIO;
      server.startAnswer = {
        status: 409,
        code: "model_needed",
        body: {
          detail: {
            detail: "Needs noise reduction.",
            model: {
              id: "rnnoise",
              variant: null,
              label: "Noise reduction (RNNoise)",
              purpose: "noise reduction",
              size: "~0.3 MB",
              size_bytes: null,
              state: "missing",
            },
          },
        },
      };
      const { land } = renderWithLanding(<Host />, {
        status: modelStatus(registryRows()),
      });
      await exportReady();
      await userEvent.click(choice(/^Broadcast/));
      await userEvent.click(
        await screen.findByRole("button", { name: "Export episode" }),
      );
      expect(await screen.findByText("Needs noise reduction")).toBeVisible();
      expect(choice(/^Broadcast/)).toHaveAttribute("aria-pressed", "true");
      if (input === "new choice" || input === "ABA")
        await userEvent.click(choice(/^Streaming/));
      if (input === "format ABA") {
        const flac = screen.getByRole("button", { name: /^FLAC/ });
        await userEvent.click(flac);
        await userEvent.click(flac);
        expect(flac).toHaveAttribute("aria-pressed", "false");
      }
      if (input === "ABA") await userEvent.click(choice(/^Broadcast/));
      revisitDeliver();
      await screen.findByText("Needs noise reduction");
      server.startAnswer = null;
      land("rnnoise");
      await waitFor(() => expect(server.watchers()).toBe(1));
      expect(server.exportRequests).toEqual([
        { path: PATH, formats: [MP3] },
        { path: PATH, formats: [MP3] },
      ]);
      await finish(EXPORT_FINISHED.result);
      expect(
        choice(
          input === "unchanged"
            ? "Project default"
            : input === "ABA" || input === "format ABA"
              ? /^Broadcast/
              : /^Streaming/,
        ),
      ).toHaveAttribute("aria-pressed", "true");
      if (input === "unchanged")
        expect(await screen.findByText("Exported")).toBeVisible();
      else
        expect(await screen.findByText("Export is out of date")).toBeVisible();
    },
  );

  it("keeps missing OPUS visible and blocks fresh Feed until the operator removes it", async () => {
    server.feed = FEED_WITHOUT_AUDIO;
    server.config = {
      config: {
        export: { wav: true, formats: [{ ext: "opus", codec: "libopus" }] },
      },
    };
    render(<Host />);
    await exportReady();
    await userEvent.click(screen.getByRole("button", { name: /^FLAC/ }));
    server.config = { config: { export: { wav: true, formats: [MP3] } } };
    revisitDeliver();
    await screen.findByRole("button", { name: /^MP3/ });
    const missing = screen.getByRole("button", { name: "OPUS · unavailable" });
    expect(missing).toHaveAttribute("aria-pressed", "true");
    const feed = screen.getByRole("button", { name: "Export episode" });
    expect(feed).toBeDisabled();
    expect(feed).toHaveAttribute(
      "title",
      "Remove unavailable formats before exporting.",
    );
    await userEvent.click(feed);
    expect(server.exportRequests).toEqual([]);
    await userEvent.click(missing);
    await userEvent.click(feed);
    await waitFor(() => expect(server.watchers()).toBe(1));
    expect(server.exportRequests).toEqual([
      { path: PATH, formats: [{ ext: "flac", codec: "flac" }] },
    ]);
  });

  it("marks a resumed Broadcast export stale when the MP3 bitrate alone changes", async () => {
    server.files = [ENTRIES[2]];
    const { land } = renderWithLanding(<Host />, {
      status: modelStatus(registryRows()),
    });
    expect(
      await screen.findByRole("button", { name: /MP3 · 128 kbps/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await startBroadcast();
    await act(async () => server.settle(EXPORT_MODEL_NEEDED));
    expect(await screen.findByText("Needs noise reduction")).toBeVisible();
    expect(server.exportRequests).toEqual([
      { path: PATH, formats: [MP3], target: "broadcast" },
    ]);

    server.config = {
      config: {
        export: { wav: true, formats: [{ ...MP3, bitrate_kbps: 96 }] },
        master: { integrated_lufs: -16, true_peak_db: -1.5 },
      },
    };
    revisitDeliver();
    expect(
      await screen.findByRole("button", { name: /MP3 · 96 kbps/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(choice(/^Broadcast/)).toHaveAttribute("aria-pressed", "true");

    server.reopen();
    server.started = { ...EXPORT_STARTED, id: "resumed-broadcast" };
    land("rnnoise");
    await waitFor(() =>
      expect(server.exportRequests).toEqual([
        { path: PATH, formats: [MP3], target: "broadcast" },
        { path: PATH, formats: [MP3], target: "broadcast" },
      ]),
    );
    await finish({
      ...BROADCAST_RESULT,
      file_ids: ["opaque:a#1"],
      edit_head_id: "root",
    });
    expect(
      await screen.findByText("Exported 1 Broadcast audio file."),
    ).toBeVisible();
    expect(choice(/^Broadcast/)).toHaveAttribute("aria-pressed", "true");
    expect({
      stale: screen.queryByText("Export is out of date")?.textContent,
      current: screen.queryByText("Exported")?.textContent,
    }).toEqual({ stale: "Export is out of date", current: undefined });
    server.config = {
      config: {
        export: { wav: true, formats: [MP3] },
        master: { integrated_lufs: -16, true_peak_db: -1.5 },
      },
    };
    revisitDeliver();
    expect(
      await screen.findByRole("button", { name: /MP3 · 128 kbps/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("Exported")).toBeVisible();
    expect(screen.queryByText("Export is out of date")).toBeNull();
    expect(screen.getByRole("link", { name: /^Download/ })).toHaveAttribute(
      "href",
      expect.stringContaining("opaque%3Aa%231"),
    );
  });

  it("distinguishes canonical settings changes from an episode edit", async () => {
    server.files = [ENTRIES[0]];
    render(<Host />);
    await userEvent.click(await exportReady());
    await waitFor(() => expect(server.watchers()).toBe(1));
    await act(async () => server.settle(EXPORT_FINISHED));

    const canonicalLink = async () =>
      expect(
        await screen.findByRole("link", { name: "Download episode.mp3, 64 B" }),
      ).toHaveAttribute(
        "href",
        "/api/export/files/canonical.mp3?path=%2Ftmp%2Fep%2Fepisode.sharecut",
      );
    const outOfDate = () =>
      waitFor(() =>
        expect({
          stale: screen.queryByText("Export is out of date")?.textContent,
          edited: screen.queryByText("Edited since export")?.textContent,
          current: screen.queryByText("Exported")?.textContent,
        }).toEqual({
          stale: "Export is out of date",
          edited: undefined,
          current: undefined,
        }),
      );
    expect(await screen.findByText("Exported")).toBeVisible();
    await canonicalLink();

    const flac = screen.getByRole("button", { name: /^FLAC/ });
    await userEvent.click(flac);
    expect(flac).toHaveAttribute("aria-pressed", "true");
    await outOfDate();
    await canonicalLink();
    await userEvent.click(flac);
    expect(flac).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Exported")).toBeVisible();
    await waitFor(() =>
      expect(
        screen.queryByText("Current export settings could not be checked."),
      ).not.toBeInTheDocument(),
    );
    await canonicalLink();

    const config = server.config;
    server.config = {
      config: {
        export: { wav: true, formats: [MP3] },
        master: { integrated_lufs: -23, true_peak_db: -1.5 },
      },
    };
    server.readSettings = async () =>
      Response.json({
        status: "available",
        settings: {
          ...exportEvidence(null, "lower-lufs"),
          master_target: { integrated_lufs: -23, true_peak_db: -1.5, lra: 11 },
        },
      });
    revisitDeliver();
    expect(
      await screen.findByText(/Project target preview is −23\.0 LUFS/),
    ).toBeVisible();
    expect(choice("Project default")).toHaveAttribute("aria-pressed", "true");
    await outOfDate();
    await canonicalLink();

    server.config = config;
    server.readSettings = async () =>
      Response.json({ status: "available", settings: exportEvidence(null) });
    revisitDeliver();
    expect(
      await screen.findByText(/Project target preview is −16\.0 LUFS/),
    ).toBeVisible();
    expect(screen.getByText("Exported")).toBeVisible();
    await waitFor(() =>
      expect(
        screen.queryByText("Current export settings could not be checked."),
      ).not.toBeInTheDocument(),
    );
    await canonicalLink();

    const { project } = useDawStore.getState();
    const head = parseHistoryEntryId("after-cut");
    if (!project || !head) throw new Error("Missing episode history fixture");
    act(() =>
      useDawStore.setState({
        project: {
          ...project,
          history: {
            ...project.history,
            head_id: head,
            groups: [{ kind: "snapshot", id: head, operation: "cut" }],
          },
        },
      }),
    );
    expect(screen.getByText("Edited since export")).toBeVisible();
    expect(screen.queryByText("Export is out of date")).not.toBeInTheDocument();
    expect(screen.queryByText("Exported")).not.toBeInTheDocument();
    await canonicalLink();
    expect(server.exportRequests).toEqual([{ path: PATH, formats: [MP3] }]);
  });

  it("marks a canonical export out of date when only mastering LRA changes", async () => {
    const configAtLra = (lra: number) => ({
      config: {
        export: { wav: true, formats: [MP3] },
        master: { integrated_lufs: -16, true_peak_db: -1.5, lra },
      },
    });
    server.config = configAtLra(11);
    server.files = [ENTRIES[0]];
    render(<Host />);
    await userEvent.click(await exportReady());
    await waitFor(() => expect(server.watchers()).toBe(1));
    await finish({ ...EXPORT_FINISHED.result, edit_head_id: "root" });

    const expectCanonicalLink = async () =>
      expect(
        await screen.findByRole("link", { name: "Download episode.mp3, 64 B" }),
      ).toHaveAttribute(
        "href",
        "/api/export/files/canonical.mp3?path=%2Ftmp%2Fep%2Fepisode.sharecut",
      );
    const reload = async (lra: number) => {
      const previous = server.configRequests.length;
      server.config = configAtLra(lra);
      server.readSettings = async () =>
        Response.json({
          status: "available",
          settings: {
            ...exportEvidence(null, lra === 11 ? "default" : "changed-lra"),
            master_target: { integrated_lufs: -16, true_peak_db: -1.5, lra },
          },
        });
      revisitDeliver();
      await act(async () => undefined);
      expect(server.configRequests).toHaveLength(previous + 1);
      expect(useDawStore.getState().project?.history.head_id).toBe("root");
      expect(
        screen.getByText(
          /Project target preview is −16\.0 LUFS, peaks under −1\.5 dBTP/,
        ),
      ).toBeVisible();
    };
    expect(await screen.findByText("Exported")).toBeVisible();
    await expectCanonicalLink();

    await reload(7);
    expect.soft(screen.queryByText("Export is out of date")).toBeVisible();
    expect.soft(screen.queryByText("Exported")).not.toBeInTheDocument();
    expect(screen.queryByText("Edited since export")).not.toBeInTheDocument();
    await expectCanonicalLink();

    await reload(11);
    expect(screen.getByText("Exported")).toBeVisible();
    expect(screen.queryByText("Export is out of date")).not.toBeInTheDocument();
    await expectCanonicalLink();
    expect(server.exportRequests).toEqual([{ path: PATH, formats: [MP3] }]);
  });

  it.each(["mp3", "..MP3"])(
    "marks a canonical export out of date when %s and mp3 format order changes on revisit",
    async (ext) => {
      const low = { ext, bitrate_kbps: 96 };
      const high = { ext: "mp3", bitrate_kbps: 192 };
      const original = {
        config: { export: { wav: false, formats: [low, high] } },
      };
      server.config = original;
      server.files = [ENTRIES[0]];
      render(<Host />);
      await userEvent.click(await exportReady());
      await waitFor(() => expect(server.watchers()).toBe(1));
      expect.soft(server.exportRequests).toEqual([
        {
          path: PATH,
          formats: [low, high],
        },
      ]);
      await finish({
        paths: ["/tmp/ep/export/ep.mp3"],
        edit_head_id: "root",
        applied_settings: exportEvidence(null),
      });
      expect(await screen.findByText("Exported")).toBeVisible();

      server.config = {
        config: { export: { wav: false, formats: [high, low] } },
      };
      revisitDeliver();
      const formatOrder = () =>
        within(screen.getByRole("group", { name: "Formats" }))
          .getAllByRole("button", { name: /(?:96|192) kbps/ })
          .map(
            (button) => button.textContent?.match(/\S+ · (?:96|192) kbps/)?.[0],
          );
      await waitFor(() =>
        expect(formatOrder().map((label) => label?.split(" · ")[1])).toEqual([
          "192 kbps",
          "96 kbps",
        ]),
      );
      expect.soft(formatOrder()).toEqual(["MP3 · 192 kbps", "MP3 · 96 kbps"]);
      expect
        .soft({
          stale: screen.queryByText("Export is out of date")?.textContent,
          edited: screen.queryByText("Edited since export")?.textContent,
          current: screen.queryByText("Exported")?.textContent,
        })
        .toEqual({
          stale: "Export is out of date",
          edited: undefined,
          current: undefined,
        });

      server.config = original;
      revisitDeliver();
      await waitFor(() =>
        expect(formatOrder().map((label) => label?.split(" · ")[1])).toEqual([
          "96 kbps",
          "192 kbps",
        ]),
      );
      expect.soft(formatOrder()).toEqual(["MP3 · 96 kbps", "MP3 · 192 kbps"]);
      expect(screen.getByText("Exported")).toBeVisible();
      expect(
        screen.queryByText("Export is out of date"),
      ).not.toBeInTheDocument();
      expect(server.exportRequests).toHaveLength(1);
    },
  );

  it.each([
    { field: "integrated_lufs", value: -19, expected: "Exported" },
    { field: "true_peak_db", value: -2, expected: "Export is out of date" },
    { field: "lra", value: 7, expected: "Export is out of date" },
  ])(
    "checks Broadcast freshness after changing only project $field",
    async ({ field, value, expected }) => {
      const master = { integrated_lufs: -16, true_peak_db: -1.5, lra: 11 };
      const config = { export: { wav: true, formats: [MP3] }, master };
      server.config = { config };
      server.files = ENTRIES;
      render(<Host />);
      await startBroadcast();
      await finish({ ...BROADCAST_RESULT, edit_head_id: "root" });

      const namedLinks = async () => {
        const files = within(
          screen.getByRole("group", { name: "Broadcast files" }),
        );
        expect(
          (await files.findAllByRole("link")).map((link) =>
            link.getAttribute("href"),
          ),
        ).toEqual([
          "/api/export/files/opaque%3Ab%3F2?path=%2Ftmp%2Fep%2Fepisode.sharecut&ticket=wav-ticket",
          "/api/export/files/opaque%3Aa%231?path=%2Ftmp%2Fep%2Fepisode.sharecut&ticket=mp3-ticket",
        ]);
      };
      expect(await screen.findByText("Exported")).toBeVisible();
      await namedLinks();

      const previous = server.configRequests.length;
      server.config = {
        config: { ...config, master: { ...master, [field]: value } },
      };
      server.readSettings = async () => {
        const basis =
          field === "integrated_lufs" ? "broadcast" : "changed-broadcast";
        const applied = exportEvidence("broadcast", basis);
        return Response.json({
          status: "available",
          settings: {
            ...applied,
            master_target:
              field === "integrated_lufs"
                ? applied.master_target
                : { ...applied.master_target, [field]: value },
          },
        });
      };
      revisitDeliver();
      await act(async () => undefined);
      expect(server.configRequests).toHaveLength(previous + 1);
      expect(useDawStore.getState().project?.history.head_id).toBe("root");
      expect(choice(/^Broadcast/)).toHaveAttribute("aria-pressed", "true");
      await namedLinks();
      expect(screen.queryByText("Edited since export")).not.toBeInTheDocument();
      expect(server.exportRequests).toEqual([
        { path: PATH, formats: [MP3], target: "broadcast" },
      ]);
      expect(screen.queryByText(expected)).toBeVisible();
    },
  );

  it("uses neutral stale copy for the same named receipt ID without a new edit", async () => {
    server.files = ENTRIES;
    render(<Host />);
    await startBroadcast();
    await finish({ ...BROADCAST_RESULT, edit_head_id: "root" });
    expect(await screen.findByText("Exported")).toBeVisible();
    const namedRows = () =>
      within(screen.getByRole("group", { name: "Broadcast files" }));
    const actionName = "episode-broadcast.mp3, 64 B";
    const href =
      "/api/export/files/opaque%3Aa%231?path=%2Ftmp%2Fep%2Fepisode.sharecut&ticket=mp3-ticket";
    const link = () =>
      namedRows().findByRole("link", { name: `Download ${actionName}` });
    expect(await link()).toHaveAttribute("href", href);
    expect(namedRows().queryByText("Export is out of date")).toBeNull();
    expect(namedRows().queryByText("Edited since export")).toBeNull();

    const listing = deferred();
    server.files = ENTRIES.map((file) =>
      file.id === "opaque:a#1" ? { ...file, current: false } : file,
    );
    server.holdFiles = listing.promise;
    revisitDeliver();
    expect(namedRows().getByText("Loading exported files…")).toBeVisible();
    await act(async () => listing.resolve());
    server.holdFiles = null;

    const download = await link();
    expect(download).toHaveAttribute("href", href);
    const row = download.closest("li");
    if (!row) throw new Error("Missing named file row");
    expect.soft(within(row).queryByText("Export is out of date")).toBeVisible();
    expect.soft(within(row).queryByText("Edited since export")).toBeNull();
    expect(useDawStore.getState().project?.history.head_id).toBe("root");

    vi.stubGlobal("isTauri", true);
    revisitDeliver();
    await userEvent.click(
      await namedRows().findByRole("button", { name: `Reveal ${actionName}` }),
    );
    expect(server.revealRequests).toEqual([{ path: PATH, id: "opaque:a#1" }]);
    expect(server.exportRequests).toEqual([
      { path: PATH, formats: [MP3], target: "broadcast" },
    ]);
  });

  it("does not infer an edit from an audio inventory stale flag", async () => {
    server.files = [{ ...ENTRIES[0], current: false }];
    render(<Host />);
    const link = await screen.findByRole("link", {
      name: "Download episode.mp3, 64 B",
    });
    const row = link.closest("li");
    if (!row) throw new Error("Missing canonical file row");
    expect(within(row).getByText("Canonical")).toBeVisible();
    expect(within(row).getByText("Export is out of date")).toBeVisible();
    expect(within(row).queryByText("Edited since export")).toBeNull();
    expect(link).toHaveAttribute(
      "href",
      "/api/export/files/canonical.mp3?path=%2Ftmp%2Fep%2Fepisode.sharecut",
    );
  });

  it("keeps a null named receipt valid and stale against the current edit head", async () => {
    server.files = ENTRIES;
    render(<Host />);
    await startBroadcast();
    await finish({ ...BROADCAST_RESULT, edit_head_id: null });

    expect(await screen.findByText("Export is out of date")).toBeVisible();
    expect(screen.queryByText("Export failed")).not.toBeInTheDocument();
    expect(
      screen.getByText("Measured −23.1 LUFS, true peak −1.6 dBTP."),
    ).toBeVisible();
    const result = within(
      screen.getByRole("group", { name: "Broadcast files" }),
    );
    expect(result.getAllByRole("link")).toHaveLength(2);
  });

  it("downloads exactly the listed receipt IDs and tickets in receipt order", async () => {
    server.files = ENTRIES;
    render(<Host />);
    await startBroadcast();
    await finish();
    const result = within(
      await screen.findByRole("group", { name: "Broadcast files" }),
    );
    await waitFor(() =>
      expect(
        result.getAllByRole("link").map((link) => link.getAttribute("href")),
      ).toEqual([
        "/api/export/files/opaque%3Ab%3F2?path=%2Ftmp%2Fep%2Fepisode.sharecut&ticket=wav-ticket",
        "/api/export/files/opaque%3Aa%231?path=%2Ftmp%2Fep%2Fepisode.sharecut&ticket=mp3-ticket",
      ]),
    );
    expect(
      screen.getByText("Measured −23.1 LUFS, true peak −1.6 dBTP."),
    ).toBeVisible();
    expect(useDawStore.getState().jobFeedback).toEqual(
      new Map([
        [
          "x1",
          {
            kind: "ready",
            outcome: {
              kind: "verified",
              copy: "Exported 2 Broadcast audio files.",
            },
          },
        ],
      ]),
    );
  });

  it("reveals by receipt ID when an unrelated file has the same name and label", async () => {
    vi.stubGlobal("isTauri", true);
    server.files = ENTRIES;
    render(<Host />);
    await startBroadcast();
    await finish();
    const result = within(
      await screen.findByRole("group", { name: "Broadcast files" }),
    );
    await userEvent.click(
      await result.findByRole("button", {
        name: /^Reveal episode-broadcast.mp3,/,
      }),
    );
    expect(server.revealRequests).toEqual([{ path: PATH, id: "opaque:a#1" }]);
  });

  it("waits for current inventory and recovers from errors and missing receipt IDs", async () => {
    server.files = ENTRIES;
    render(<Host />);
    expect(await screen.findByText("episode-broadcast.wav")).toBeVisible();
    await startBroadcast();
    const listing = deferred();
    server.holdFiles = listing.promise;
    server.fileAnswer = { status: 500, body: { detail: "offline" } };
    await finish();
    const result = within(
      await screen.findByRole("group", { name: "Broadcast files" }),
    );
    expect(result.getByText("Loading exported files…")).toBeVisible();
    expect(result.queryAllByRole("link")).toEqual([]);

    server.holdFiles = null;
    await act(async () => listing.resolve());
    expect(
      await result.findByText("Exported files could not be loaded."),
    ).toBeVisible();
    expect(result.queryAllByRole("link")).toEqual([]);

    server.fileAnswer = null;
    server.files = ENTRIES.slice(0, -1);
    await userEvent.click(
      result.getByRole("button", { name: "Refresh files" }),
    );
    expect(
      await result.findByText("Some files from this export are missing."),
    ).toBeVisible();
    expect(result.queryAllByRole("link")).toEqual([]);

    server.files = ENTRIES;
    await userEvent.click(
      result.getByRole("button", { name: "Refresh files" }),
    );
    expect(await result.findAllByRole("link")).toHaveLength(2);
  });

  it.each([
    { name: "missing result", result: null },
    { name: "empty IDs", result: { ...BROADCAST_RESULT, file_ids: [] } },
    {
      name: "duplicate IDs",
      result: { ...BROADCAST_RESULT, file_ids: ["x", "x"] },
    },
    {
      name: "wrong target",
      result: { ...BROADCAST_RESULT, target: "streaming" },
    },
    { name: "bad edit head", result: { ...BROADCAST_RESULT, edit_head_id: 4 } },
    {
      name: "malformed measurement",
      result: {
        ...BROADCAST_RESULT,
        master: { ...MASTER, measured: { integrated_lufs: "−23" } },
      },
    },
    {
      name: "missing measurements",
      result: { ...BROADCAST_RESULT, master: { within_tolerance: true } },
    },
    {
      name: "empty measurements",
      result: {
        ...BROADCAST_RESULT,
        master: { ...MASTER, measured: {} },
      },
    },
    {
      name: "missing integrated loudness",
      result: {
        ...BROADCAST_RESULT,
        master: { ...MASTER, measured: { true_peak_db: -1.6 } },
      },
    },
    {
      name: "null integrated loudness",
      result: {
        ...BROADCAST_RESULT,
        master: {
          ...MASTER,
          measured: { integrated_lufs: null, true_peak_db: -1.6 },
        },
      },
    },
    {
      name: "missing true peak",
      result: {
        ...BROADCAST_RESULT,
        master: { ...MASTER, measured: { integrated_lufs: -23.1 } },
      },
    },
    {
      name: "null true peak",
      result: {
        ...BROADCAST_RESULT,
        master: {
          ...MASTER,
          measured: { integrated_lufs: -23.1, true_peak_db: null },
        },
      },
    },
    {
      name: "failed QC",
      result: {
        ...BROADCAST_RESULT,
        master: { ...MASTER, within_tolerance: false },
      },
    },
  ])(
    "fails instead of announcing publication for $name",
    async ({ result }) => {
      render(<Host />);
      await startBroadcast();
      await finish(result);
      expect(await screen.findByText("Export failed")).toBeVisible();
      expect(
        screen.getByText(
          "The export result could not be verified. Try exporting again.",
        ),
      ).toBeVisible();
      expect(useDawStore.getState().jobFeedback).toEqual(
        new Map([
          [
            "x1",
            {
              kind: "ready",
              outcome: {
                kind: "failure",
                copy: "Export failed. The export result could not be verified. Try exporting again.",
              },
            },
          ],
        ]),
      );
      expect(useDawStore.getState().spokenJobResultIds).not.toContain("x1");
    },
  );

  it("settles an unpublished cancellation without a publication announcement", async () => {
    render(<Host />);
    await startBroadcast();
    await finish(null, "cancelled");
    expect(await screen.findByText("Export cancelled")).toBeVisible();
    expect(useDawStore.getState().jobFeedback).toEqual(new Map([]));
  });

  it("reports the committed files after a late cancellation", async () => {
    server.files = ENTRIES;
    render(<Host />);
    await startBroadcast();
    await finish(BROADCAST_RESULT, "cancelled");
    expect(
      await screen.findByText(
        "Cancel came too late. Exported 2 Broadcast audio files.",
      ),
    ).toBeVisible();
    const result = within(
      await screen.findByRole("group", { name: "Broadcast files" }),
    );
    expect(await result.findAllByRole("link")).toHaveLength(2);
    expect(useDawStore.getState().jobFeedback).toEqual(
      new Map([
        [
          "x1",
          {
            kind: "ready",
            outcome: {
              kind: "verified",
              copy: "Cancel came too late. Exported 2 Broadcast audio files.",
            },
          },
        ],
      ]),
    );
  });

  it("treats a malformed committed cancellation as failure", async () => {
    render(<Host />);
    await startBroadcast();
    await finish({ ...BROADCAST_RESULT, file_ids: [] }, "cancelled");
    expect(await screen.findByText("Export failed")).toBeVisible();
    expect(useDawStore.getState().jobFeedback).toEqual(
      new Map([
        [
          "x1",
          {
            kind: "ready",
            outcome: {
              kind: "failure",
              copy: "Export failed. The export result could not be verified. Try exporting again.",
            },
          },
        ],
      ]),
    );

    const store = useDawStore.getState;
    act(() => store().announceStatus("Saved the edit"));
    const toast = store().feedbackToast;
    expect(toast?.message).toBe("Saved the edit");
    const shell = render(<StatusLive />);
    const live = within(shell.container).getByRole("status");
    const guidance =
      "Export failed. The export result could not be verified. Try exporting again.";
    expect(live.textContent).toBe(guidance);
    expect(store().jobFeedback.get("x1")).toEqual({
      kind: "failure-delivered",
    });
    expect(store().feedbackToast).toBe(toast);
    const seq = store().statusAnnouncementSeq;

    act(() =>
      store().setActivityJob({ ...EXPORT_STARTED, status: "cancelled" }),
    );
    expect.soft(live.textContent).toBe(guidance);
    expect.soft(store().statusAnnouncementSeq).toBe(seq);
    expect(store().feedbackToast).toBe(toast);
  });

  it("keeps a running export's target separate from the next choice", async () => {
    server.files = ENTRIES;
    render(<Host />);
    await startBroadcast();
    await userEvent.click(choice(/^Streaming/));
    await finish({ ...BROADCAST_RESULT, edit_head_id: "root" });
    expect(await screen.findByText("Export is out of date")).toBeVisible();
    expect(screen.getByText("Exported 2 Broadcast audio files.")).toBeVisible();
    await userEvent.click(choice(/^Broadcast/));
    expect(screen.queryByText("Export is out of date")).not.toBeInTheDocument();
    expect(screen.getByText("Exported 2 Broadcast audio files.")).toBeVisible();
  });

  it("does not offer inventory files as the result of a failed named export", async () => {
    server.files = ENTRIES;
    render(<Host />);
    expect(
      await screen.findByRole("link", { name: /^Download episode.mp3,/ }),
    ).toBeVisible();
    await startBroadcast();
    await act(async () =>
      server.settle({
        ...EXPORT_STARTED,
        status: "error",
        error: "The mix needs to be refreshed.",
      }),
    );
    expect(await screen.findByText("Export failed")).toBeVisible();
    const episode = within(
      screen.getByRole("region", { name: "Episode file" }),
    );
    expect(episode.queryAllByRole("link")).toEqual([]);
    expect(useDawStore.getState().jobFeedback).toEqual(
      new Map([["x1", { kind: "unverified" }]]),
    );
  });

  it("accepts a different valid edit head as a stale receipt", async () => {
    server.files = ENTRIES;
    render(<Host />);
    await startBroadcast();
    await finish({ ...BROADCAST_RESULT, edit_head_id: "earlier-edit" });
    expect(await screen.findByText("Export is out of date")).toBeVisible();
    await userEvent.click(choice(/^Streaming/));
    expect(choice(/^Streaming/)).toHaveAttribute("aria-pressed", "true");
    const result = within(
      screen.getByRole("group", { name: "Broadcast files" }),
    );
    expect(await result.findAllByRole("link")).toHaveLength(2);
    expect(screen.getByText("Exported 2 Broadcast audio files.")).toBeVisible();
  });

  it.each([
    {
      replacement: "a different project",
      other: "/tmp/replacement/episode.sharecut",
    },
    { replacement: "a reopened project", other: PATH },
  ])(
    "does not let an old pending start clear a run in $replacement",
    async ({ other }) => {
      const oldStart = deferred();
      server.holdStart = oldStart.promise;
      render(<Host />);
      const button = await exportReady();
      await userEvent.click(choice(/^Broadcast/));
      await userEvent.click(button);
      await waitFor(() =>
        expect(server.exportRequests).toEqual([
          { path: PATH, formats: [MP3], target: "broadcast" },
        ]),
      );

      server.holdStart = null;
      server.started = { ...EXPORT_STARTED, id: "x2", project_path: other };
      act(() => {
        if (other === PATH) asHost("/tmp/intermediate/episode.sharecut");
        asHost(other);
      });
      await userEvent.click(await exportReady());
      await waitFor(() => expect(server.watchers()).toBe(1));
      await act(async () => oldStart.resolve());
      expect(await screen.findByText("Exporting")).toBeVisible();
      expect(server.exportRequests[1]).toEqual({ path: other, formats: [MP3] });
      await finish({ paths: ["episode.wav"] });
      expect(await screen.findByText("Exported")).toBeVisible();
      expect(useDawStore.getState().jobFeedback).toEqual(
        new Map([
          [
            "x2",
            {
              kind: "ready",
              outcome: { kind: "verified", copy: "Exported 1 file to export/" },
            },
          ],
        ]),
      );
    },
  );
});
