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
import { FeaturesContext } from "../../extensions/FeaturesContext";
import { FEATURE_SHARE_UI_MENU } from "../../extensions/features";
import { useDawStore } from "../../state/dawStore";
import { deferred } from "../../test/deferred";
import { fakeExportServer } from "../../test/fakeExportServer";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { DeliverStage } from "./DeliverStage";
import { ExportFlowProvider } from "./exportFlow";
import { ShareFlowProvider } from "./shareFlow";

const PATH = "/tmp/ep/episode.sharecut";
const MP3 = { ext: "mp3", codec: "libmp3lame", bitrate_kbps: 128 };
const TARGET = { path: PATH, formats: [MP3], target: "podcast" };
const FILE_IDS = [
  `variants/${"a".repeat(64)}/audio.wav`,
  `variants/${"b".repeat(64)}/audio.mp3`,
];
const SETTINGS_A = {
  version: 1,
  basis: "a".repeat(64),
  target: "podcast",
  master_target: { integrated_lufs: -16, true_peak_db: -1.5, lra: 11 },
  qc_limits: { lufs_tolerance_lu: 0.5, true_peak_tolerance_db: 0.3 },
  audio_formats: ["wav", "mp3"],
};
const SETTINGS_B = {
  version: 1,
  basis: "b".repeat(64),
  target: "podcast",
  master_target: { integrated_lufs: -16, true_peak_db: -1, lra: 11 },
  qc_limits: { lufs_tolerance_lu: 0.5, true_peak_tolerance_db: 0.3 },
  audio_formats: ["wav", "mp3"],
};
const RECEIPT = {
  file_ids: FILE_IDS,
  target: "podcast",
  master: {
    target: SETTINGS_A.master_target,
    limits: SETTINGS_A.qc_limits,
    measured: { integrated_lufs: -16.1, true_peak_db: -1.6 },
    input_stats: null,
    plan: "unknown",
    normalization_type: null,
    limiter: null,
    within_tolerance: true,
    issues: [],
  },
  edit_head_id: "root",
  applied_settings: SETTINGS_A,
};
const FILES = [
  {
    id: FILE_IDS[0],
    name: "audio.wav",
    kind: "audio",
    label: "Podcast (-16 LUFS) · WAV",
    bytes: 128,
    current: true,
    ticket: "podcast-wav-ticket",
  },
  {
    id: FILE_IDS[1],
    name: "audio.mp3",
    kind: "audio",
    label: "Podcast (-16 LUFS) · MP3",
    bytes: 64,
    current: true,
    ticket: "podcast-mp3-ticket",
  },
] satisfies ReturnType<typeof fakeExportServer>["files"];

let server: ReturnType<typeof fakeExportServer>;
let settingsResponse: unknown;

function Stages() {
  const stage = useDawStore((state) => state.stage);
  return stage === "deliver" ? <DeliverStage /> : <p>another stage</p>;
}

function Host() {
  return (
    <FeaturesContext.Provider
      value={{
        ready: true,
        manifest: { api_version: 1, features: [FEATURE_SHARE_UI_MENU] },
      }}
    >
      <ExportFlowProvider>
        <ShareFlowProvider>
          <Stages />
        </ShareFlowProvider>
      </ExportFlowProvider>
    </FeaturesContext.Provider>
  );
}

function available(settings: unknown) {
  return Response.json({ status: "available", settings });
}

beforeEach(() => {
  server = fakeExportServer();
  settingsResponse = SETTINGS_B;
  server.readSettings = async () => available(settingsResponse);
  server.config = {
    config: {
      export: { wav: true, formats: [MP3] },
      master: { integrated_lufs: -16, true_peak_db: -1.5 },
    },
  };
  server.files = FILES;
  stubViewportShell("desktop");
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.setState({
    activityJob: null,
    jobFeedback: new Map(),
    spokenJobResultIds: [],
  });
  useDawStore
    .getState()
    .hydrate(PATH, minimalProject({ tracks: [sampleTrack()] }));
  useDawStore.setState({ stage: "deliver", guestMode: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function exportPodcast(result: Record<string, unknown> = RECEIPT) {
  const view = render(<Host />);
  const exportButton = await screen.findByRole("button", { name: "Export" });
  await waitFor(() => expect(exportButton).toBeEnabled());
  await userEvent.click(
    within(screen.getByRole("group", { name: "Loudness" })).getByRole(
      "button",
      { name: /^Podcast\s*−16$/ },
    ),
  );
  await userEvent.click(exportButton);
  await waitFor(() => expect(server.watchers()).toBe(1));
  expect(server.exportRequests).toEqual([TARGET]);
  await act(async () =>
    server.settle({
      ...server.started,
      status: "ok",
      result,
    }),
  );
  return view;
}

async function expectReceiptDetails() {
  expect(
    await screen.findByText("Measured −16.1 LUFS, true peak −1.6 dBTP."),
  ).toBeVisible();
  const files = within(
    await screen.findByRole("group", { name: "Podcast files" }),
  );
  const mp3 = await files.findByRole("link", {
    name: "Download audio.mp3, 64 B",
  });
  expect(mp3).toHaveAttribute(
    "href",
    "/api/export/files/variants/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/audio.mp3?path=%2Ftmp%2Fep%2Fepisode.sharecut&ticket=podcast-mp3-ticket",
  );
  expect(
    files.getByRole("link", { name: "Download audio.wav, 128 B" }),
  ).toHaveAttribute(
    "href",
    "/api/export/files/variants/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/audio.wav?path=%2Ftmp%2Fep%2Fepisode.sharecut&ticket=podcast-wav-ticket",
  );
}

describe("host export settings evidence", () => {
  it("marks a successful receipt out of date when the correlated host basis changes", async () => {
    await exportPodcast();

    expect(await screen.findByText("Export is out of date")).toBeVisible();
    expect(
      await screen.findByText("Exported 2 Podcast audio files."),
    ).toBeVisible();
    await expectReceiptDetails();
    expect(server.settingsRequests.map(({ body }) => body)).toEqual([TARGET]);
  });

  it("keeps a successful receipt current when producer and host bases match", async () => {
    settingsResponse = SETTINGS_A;
    await exportPodcast();

    expect(
      await screen.findByText("Exported 2 Podcast audio files."),
    ).toBeVisible();
    expect(screen.queryByText("Export is out of date")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Current export settings could not be checked."),
    ).not.toBeInTheDocument();
    await expectReceiptDetails();
  });
});

it("keeps explicitly added FLAC on a property-order-only catalog revisit", async () => {
  const applied = { ...SETTINGS_A, target: null };
  settingsResponse = applied;
  server.configAnswer = { status: 503, body: { detail: "offline" } };
  const { container } = render(<Host />);
  await screen.findByText(/Export settings did not load: offline/);
  await userEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(server.watchers()).toBe(1));
  await act(async () =>
    server.settle({
      ...server.started,
      status: "ok",
      result: { paths: ["/tmp/ep/export/ep.mp3"], applied_settings: applied },
    }),
  );
  await waitFor(() =>
    expect(container.querySelector("[data-highlight]")).toBeInTheDocument(),
  );
  expect(server.exportRequests).toEqual([{ path: PATH, formats: null }]);

  const revisit = () => {
    act(() => useDawStore.setState({ stage: "edit" }));
    act(() => useDawStore.setState({ stage: "deliver" }));
  };
  server.configAnswer = null;
  revisit();
  await waitFor(() =>
    expect(container.querySelector("[data-highlight]")).toBeInTheDocument(),
  );
  expect(screen.getByRole("button", { name: /^MP3/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await userEvent.click(screen.getByRole("button", { name: /^FLAC/ }));
  expect(await screen.findByText("Export is out of date")).toBeVisible();

  server.config = {
    config: {
      export: {
        wav: true,
        formats: [{ bitrate_kbps: 128, codec: "libmp3lame", ext: "mp3" }],
      },
      master: { integrated_lufs: -16, true_peak_db: -1.5 },
    },
  };
  revisit();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled(),
  );
  expect
    .soft(screen.getByRole("button", { name: /^FLAC/ }))
    .toHaveAttribute("aria-pressed", "true");
  expect.soft(screen.queryByText("Export is out of date")).toBeVisible();
  expect
    .soft(container.querySelector("[data-highlight]"))
    .not.toBeInTheDocument();
  expect(server.settingsRequests.map(({ body }) => body)).toEqual([
    { path: PATH, formats: null },
    { path: PATH, formats: null },
  ]);
});

it("ignores a pending settings reply after leaving and revisiting the same receipt", async () => {
  const old = deferred<Response>();
  const applied = { ...SETTINGS_A, target: null };
  const request = { path: PATH, formats: [MP3] };
  server.readSettings = () => old.promise;
  server.files = [
    {
      id: "ep.mp3",
      name: "ep.mp3",
      kind: "audio",
      label: "Listening file",
      bytes: 64,
      current: true,
      ticket: "mp3-ticket",
    },
  ];
  const { container } = render(<Host />);
  const button = await screen.findByRole("button", { name: "Export" });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
  await waitFor(() => expect(server.watchers()).toBe(1));
  await act(async () =>
    server.settle({
      ...server.started,
      status: "ok",
      result: {
        paths: ["/tmp/ep/export/ep.mp3"],
        master: RECEIPT.master,
        applied_settings: applied,
      },
    }),
  );
  expect(server.settingsRequests.map(({ body }) => body)).toEqual([request]);
  expect(container.querySelector("[data-highlight]")).not.toBeInTheDocument();
  const expectDetails = async () => {
    expect(screen.getByText("Exported 1 file to export/")).toBeVisible();
    expect(
      screen.getByText("Measured −16.1 LUFS, true peak −1.6 dBTP."),
    ).toBeVisible();
    expect(
      await screen.findByRole("link", { name: "Download ep.mp3, 64 B" }),
    ).toHaveAttribute(
      "href",
      "/api/export/files/ep.mp3?path=%2Ftmp%2Fep%2Fepisode.sharecut&ticket=mp3-ticket",
    );
  };
  await expectDetails();
  const announcement = useDawStore.getState().statusAnnouncementSeq;

  act(() => useDawStore.setState({ stage: "edit" }));
  expect(screen.getByText("another stage")).toBeVisible();
  expect(server.settingsRequests[0].signal?.aborted).toBe(true);
  const newer = deferred<Response>();
  server.readSettings = () => newer.promise;
  act(() => useDawStore.setState({ stage: "deliver" }));
  await waitFor(() =>
    expect(server.settingsRequests.map(({ body }) => body)).toEqual([
      request,
      request,
    ]),
  );
  await act(async () =>
    newer.resolve(Response.json({ status: "unavailable" })),
  );
  expect(
    screen.getByText("Current export settings could not be checked."),
  ).toBeVisible();
  await act(async () => old.resolve(available(applied)));

  expect(
    screen.getByText("Current export settings could not be checked."),
  ).toBeVisible();
  expect(container.querySelector("[data-highlight]")).not.toBeInTheDocument();
  await expectDetails();
  expect(useDawStore.getState().statusAnnouncementSeq).toBe(announcement);
  expect(server.exportRequests).toEqual([request]);
});

describe("successful files with uncertain settings", () => {
  it.each([
    ["missing", undefined],
    ["wrong target", { ...SETTINGS_A, target: null }],
    ["unsupported version", { ...SETTINGS_A, version: 2 }],
    ["malformed limits", { ...SETTINGS_A, qc_limits: {} }],
  ])(
    "keeps the receipt usable when applied evidence is %s",
    async (_label, evidence) => {
      await exportPodcast({ ...RECEIPT, applied_settings: evidence });

      expect(
        await screen.findByText(
          "Current export settings could not be checked.",
        ),
      ).toBeVisible();
      expect(screen.getByText("Exported 2 Podcast audio files.")).toBeVisible();
      await expectReceiptDetails();
    },
  );

  it("labels cached mastering settings as a preview when the producer used newer defaults", async () => {
    const applied = { ...SETTINGS_B, target: null };
    settingsResponse = applied;
    const { container } = render(<Host />);
    const button = await screen.findByRole("button", { name: "Export" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await waitFor(() => expect(server.watchers()).toBe(1));
    await act(async () =>
      server.settle({
        ...server.started,
        status: "ok",
        result: {
          paths: ["/tmp/ep/export/ep.wav"],
          master: RECEIPT.master,
          applied_settings: applied,
        },
      }),
    );

    expect(await screen.findByText(/Project target.*−1\.5 dBTP/)).toBeVisible();
    expect(
      await screen.findByText("Measured −16.1 LUFS, true peak −1.6 dBTP."),
    ).toBeVisible();
    expect(screen.queryByText(/Mastered to/)).not.toBeInTheDocument();
    expect(server.settingsRequests.map(({ body }) => body)).toEqual([
      { path: PATH, formats: [MP3] },
    ]);
    expect(container.querySelector("[data-highlight]")).toBeInTheDocument();

    const announcement = useDawStore.getState().statusAnnouncementSeq;
    const config = deferred();
    server.holdConfig = config.promise;
    act(() => useDawStore.setState({ stage: "edit" }));
    expect(screen.getByText("another stage")).toBeVisible();
    act(() => useDawStore.setState({ stage: "deliver" }));
    expect(
      await screen.findByText("Current export settings could not be checked."),
    ).toBeVisible();
    expect(container.querySelector("[data-highlight]")).not.toBeInTheDocument();
    expect(screen.getByText("Exported 1 file to export/")).toBeVisible();
    expect(server.settingsRequests).toHaveLength(1);

    server.holdConfig = null;
    await act(async () => config.resolve());
    expect(server.settingsRequests).toHaveLength(2);
    expect(container.querySelector("[data-highlight]")).toBeInTheDocument();
    expect(useDawStore.getState().statusAnnouncementSeq).toBe(announcement);
    expect(server.exportRequests).toEqual([{ path: PATH, formats: [MP3] }]);
  });
});

it.each([
  [
    "unavailable",
    () =>
      Response.json({
        status: "unavailable",
        code: "export_settings_unavailable",
      }),
  ],
  ["malformed", () => available({ ...SETTINGS_A, audio_formats: ["future"] })],
  ["wrong target", () => available({ ...SETTINGS_A, target: null })],
  ["failed", () => new Response(null, { status: 503 })],
])(
  "keeps a valid file result after a %s settings read",
  async (_label, respond) => {
    server.readSettings = async () => respond();
    await exportPodcast();

    expect(
      await screen.findByText("Current export settings could not be checked."),
    ).toBeVisible();
    expect(screen.getByText("Exported 2 Podcast audio files.")).toBeVisible();
    expect(server.settingsRequests.map(({ body }) => body)).toEqual([TARGET]);
    await expectReceiptDetails();
  },
);
