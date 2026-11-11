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

import { clearRegisteredCommands, execute } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { PENDING } from "../../stages/deliver/feedFixture";
import { useDawStore } from "../../state/dawStore";
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
  renderWithModels,
} from "../../test/renderWithModels";
import { stubViewportShell } from "../../test/viewportShell";
import type { HistoryEntryId } from "../../types/project";
import { StatusLive } from "../frame/StatusLive";
import { DeliverStage } from "./DeliverStage";
import { ExportFlowProvider } from "./exportFlow";
import { ShareFlowProvider } from "./shareFlow";

const PATH = "/tmp/ep/episode.sharecut";
const MP3 = { ext: "mp3", codec: "libmp3lame", bitrate_kbps: 128 };
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

let server: ReturnType<typeof fakeExportServer>;

function Stages() {
  const stage = useDawStore((s) => s.stage);
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

const exportButton = () =>
  screen.getAllByRole("button", { name: "Export" })[0] as HTMLElement;

async function ready() {
  await waitFor(() => expect(exportButton()).toBeEnabled());
}

async function pressExport() {
  await ready();
  await userEvent.click(exportButton());
  await waitFor(() => expect(server.exportRequests).toHaveLength(1));
}

function asHost(path = PATH) {
  useDawStore
    .getState()
    .hydrate(path, minimalProject({ tracks: [sampleTrack()] }));
  useDawStore.setState({ stage: "deliver", guestMode: null });
}

const realAnnounceStatus = useDawStore.getState().announceStatus;

beforeEach(() => {
  useDawStore.setState({ announceStatus: realAnnounceStatus });
  server = fakeExportServer();
  stubViewportShell("desktop");
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.setState({ activityJob: null, jobFeedback: new Map() });
  asHost();
});

afterEach(() => {
  useDawStore.setState({ announceStatus: realAnnounceStatus });
  vi.unstubAllGlobals();
});

describe("Export on the Deliver stage", () => {
  it("offers the project's formats and says WAV is written with every export", async () => {
    render(<Host />);
    const formats = await screen.findByRole("group", { name: "Formats" });
    await waitFor(() =>
      expect(within(formats).getAllByRole("button")).toHaveLength(4),
    );
    expect(within(formats).getByRole("button", { name: "WAV" })).toBeDisabled();
    expect(
      within(formats).getByRole("button", { name: /^MP3/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(formats).getByRole("button", { name: /^FLAC/ }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(/written with every export/)).toBeInTheDocument();
  });

  it("does not promise WAV or admit a named export with wav set to zero and no selected format", async () => {
    server.config = { config: { export: { wav: 0, formats: [MP3] } } };
    render(<Host />);
    await ready();
    const formats = within(screen.getByRole("group", { name: "Formats" }));
    const mp3 = formats.getByRole("button", { name: /^MP3/ });
    expect(mp3).toHaveAttribute("aria-pressed", "true");
    expect
      .soft(formats.queryByRole("button", { name: "WAV" }))
      .not.toBeInTheDocument();
    expect
      .soft(screen.queryByText(/written with every export/))
      .not.toBeInTheDocument();

    await userEvent.click(
      within(screen.getByRole("group", { name: "Loudness" })).getByRole(
        "button",
        { name: /^Broadcast/ },
      ),
    );
    await userEvent.click(mp3);
    expect(mp3).toHaveAttribute("aria-pressed", "false");
    expect.soft(exportButton()).toBeDisabled();
    expect
      .soft(exportButton())
      .toHaveAttribute("title", "Choose a format first.");
    await userEvent.click(exportButton());
    expect(server.exportRequests).toEqual([]);
  });

  it("shows project-default Loudness and leaves Range and Saves to out", async () => {
    render(<Host />);
    await ready();
    expect(
      within(screen.getByRole("group", { name: "Loudness" })).getByRole(
        "button",
        { name: "Project default" },
      ),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("group", { name: "Range" })).toBeNull();
    expect(screen.queryByText(/Saves to/)).toBeNull();
    expect(
      screen.getByText(
        /Project target preview is −16\.0 LUFS, peaks under −1\.5 dBTP/,
      ),
    ).toBeInTheDocument();
  });

  it("posts the chosen formats to the export route", async () => {
    render(<Host />);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /^FLAC/ }));
    await userEvent.click(exportButton());
    await waitFor(() => expect(server.exportRequests).toHaveLength(1));
    expect(server.exportRequests[0]).toEqual({
      path: PATH,
      formats: [MP3, { ext: "flac", codec: "flac" }],
    });
  });

  it("explains unreadable formats and requests the saved-format fallback", async () => {
    server.config = {
      config: { export: { wav: false, formats: [{ codec: "flac" }] } },
    };
    render(<Host />);
    expect(
      await screen.findByText(
        "Export settings did not load: Could not read the configured export formats. Export uses this project's saved formats.",
      ),
    ).toBeVisible();
    await userEvent.click(exportButton());
    await waitFor(() =>
      expect(server.exportRequests).toEqual([{ path: PATH, formats: null }]),
    );
  });

  it("blocks both Feed export controls until a format is selected", async () => {
    server.feed = FEED_WITHOUT_AUDIO;
    server.config = { config: { export: { wav: false, formats: [MP3] } } };
    render(<Host />);
    await ready();
    const user = userEvent.setup();
    const formats = within(screen.getByRole("group", { name: "Formats" }));
    const mp3 = formats.getByRole("button", { name: /^MP3 · 128 kbps/ });
    expect(mp3).toHaveAttribute("aria-pressed", "true");
    await user.click(mp3);
    expect(mp3).toHaveAttribute("aria-pressed", "false");
    expect(exportButton()).toBeDisabled();
    expect(exportButton()).toHaveAttribute("title", "Choose a format first.");

    const readiness = await screen.findByRole("button", {
      name: "Export episode",
    });
    await user.click(screen.getByText("Checks"));
    const check = screen.getByRole("button", {
      name: "Export episode: Export the episode to supply the audio.",
    });
    for (const control of [readiness, check]) {
      expect.soft(control).toBeDisabled();
      expect
        .soft(control)
        .toHaveAccessibleDescription("Choose a format first.");
      await user.click(control);
    }
    expect(server.exportRequests).toEqual([]);

    await user.click(mp3);
    expect(mp3).toHaveAttribute("aria-pressed", "true");
    expect(readiness).toBeEnabled();
    expect(check).toBeEnabled();
    await user.click(check);
    await waitFor(() =>
      expect(server.exportRequests).toEqual([
        {
          path: PATH,
          formats: [{ ext: "mp3", codec: "libmp3lame", bitrate_kbps: 128 }],
        },
      ]),
    );
  });

  it.each([
    { shell: "desktop", name: "Export" },
    { shell: "phone", name: "Export" },
    { shell: "desktop", name: "Export episode" },
  ] as const)(
    "waits for refreshed settings before starting from $name on $shell",
    async ({ shell, name }) => {
      stubViewportShell(shell);
      server.feed = FEED_WITHOUT_AUDIO;
      const flac = { ext: "flac", codec: "flac" };
      const configAtLufs = (integrated_lufs: number) => ({
        config: {
          export: { wav: true, formats: [flac] },
          master: { integrated_lufs, true_peak_db: -1.5 },
        },
      });
      const appliedAtLufs = (lufs: number) => ({
        ...exportEvidence(null, `flac-at-${lufs}`),
        master_target: { integrated_lufs: lufs, true_peak_db: -1.5, lra: 11 },
        audio_formats: ["wav", "flac"],
      });
      const readAtLufs = (lufs: number) => async () =>
        Response.json({ status: "available", settings: appliedAtLufs(lufs) });
      const action = () =>
        name === "Export"
          ? waitFor(exportButton)
          : screen.findByRole("button", { name });
      const chooseStage = (stage: "edit" | "deliver") =>
        act(() => useDawStore.setState({ stage }));

      render(
        <>
          <Host />
          <StatusLive />
        </>,
      );
      await ready();
      expect(
        await screen.findByText(/Project target preview is −16\.0 LUFS/),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: /MP3 · 128 kbps/ }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(await action()).toBeEnabled();
      const previousLoads = server.configRequests.length;
      chooseStage("edit");
      expect(screen.getByText("another stage")).toBeVisible();

      const config = deferred();
      server.config = configAtLufs(-23);
      server.readSettings = readAtLufs(-23);
      server.holdConfig = config.promise;
      chooseStage("deliver");
      let postsWhilePending = 0;
      try {
        await waitFor(() =>
          expect(server.configRequests).toHaveLength(previousLoads + 1),
        );
        const pendingAction = await action();
        expect(
          screen.getByText(/Project target preview is −16\.0 LUFS/),
        ).toBeVisible();
        expect.soft(pendingAction).toBeDisabled();
        expect
          .soft(pendingAction)
          .toHaveAccessibleDescription("Wait for the settings to load.");
        await userEvent.click(pendingAction);
        postsWhilePending = server.exportRequests.length;
        expect.soft(server.exportRequests).toEqual([]);
        const reason = [
          pendingAction.getAttribute("title"),
          ...screen
            .queryAllByText(/Loading export settings/)
            .map((node) => node.textContent),
        ].join(" ");
        expect.soft(reason).toMatch(/Loading export settings/);
      } finally {
        server.holdConfig = null;
        await act(async () => config.resolve());
      }

      expect(
        await screen.findByText(/Project target preview is −23\.0 LUFS/),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: /^FLAC/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const previousPosts = server.exportRequests.length;
      expect(previousPosts).toBe(postsWhilePending);
      if (previousPosts > 0) {
        await waitFor(() => expect(server.watchers()).toBe(1));
        await act(async () =>
          server.settle({ ...EXPORT_STARTED, status: "cancelled" }),
        );
        expect(await screen.findByText("Export cancelled")).toBeVisible();
        server.reopen();
        server.started = { ...EXPORT_STARTED, id: "after-settings-load" };
      }

      expect(await action()).toBeEnabled();
      await userEvent.click(await action());
      await waitFor(() =>
        expect(server.exportRequests.slice(previousPosts)).toEqual([
          { path: PATH, formats: [flac] },
        ]),
      );
      await waitFor(() => expect(server.watchers()).toBe(1));
      await act(async () =>
        server.settle({
          ...EXPORT_FINISHED,
          id: server.started.id,
          result: {
            paths: ["/tmp/ep/export/ep.wav", "/tmp/ep/export/ep.flac"],
            applied_settings: appliedAtLufs(-23),
            edit_head_id: "root",
          },
        }),
      );
      expect(await screen.findByText("Exported")).toBeVisible();

      server.config = configAtLufs(-16);
      server.readSettings = readAtLufs(-16);
      chooseStage("edit");
      chooseStage("deliver");
      expect(
        await screen.findByText(/Project target preview is −16\.0 LUFS/),
      ).toBeVisible();
      expect(await screen.findByText("Export is out of date")).toBeVisible();
      expect(screen.queryByText("Edited since export")).toBeNull();

      server.config = configAtLufs(-23);
      server.readSettings = readAtLufs(-23);
      chooseStage("edit");
      chooseStage("deliver");
      expect(
        await screen.findByText(/Project target preview is −23\.0 LUFS/),
      ).toBeVisible();
      expect(screen.getByText("Exported")).toBeVisible();
      expect(screen.queryByText("Export is out of date")).toBeNull();
      expect(server.exportRequests).toHaveLength(previousPosts + 1);
    },
  );

  it("marks Exported as edited after the document changes", async () => {
    render(<Host />);
    await pressExport();
    await act(async () => server.settle(EXPORT_FINISHED));
    expect(await screen.findByText("Exported")).toBeInTheDocument();
    const project = useDawStore.getState().project;
    if (!project) throw new Error("fixture");
    act(() =>
      useDawStore.setState({
        project: {
          ...project,
          history: {
            ...project.history,
            head_id: "after-the-export" as HistoryEntryId,
          },
        },
      }),
    );
    expect(await screen.findByText("Edited since export")).toBeInTheDocument();
    expect(screen.queryByText("Exported")).toBeNull();
  });

  it("stays Exported when only a mix rebuild entry lands while it runs", async () => {
    const setHistory = (head: string, groups: object[]) => {
      const project = useDawStore.getState().project;
      if (!project) throw new Error("fixture");
      act(() =>
        useDawStore.setState({
          project: {
            ...project,
            history: {
              ...project.history,
              head_id: head as HistoryEntryId,
              groups: groups as typeof project.history.groups,
            },
          },
        }),
      );
    };
    const cut = { kind: "snapshot", id: "e1", operation: "cut" };
    setHistory("e1", [cut]);
    render(<Host />);
    await pressExport();
    setHistory("p1", [
      cut,
      { kind: "snapshot", id: "p1", operation: "render_preview" },
    ]);
    await act(async () =>
      server.settle({
        ...EXPORT_FINISHED,
        result: { ...EXPORT_FINISHED.result, edit_head_id: "e1" },
      }),
    );
    expect(await screen.findByText("Exported")).toBeInTheDocument();
    expect(screen.queryByText("Edited since export")).toBeNull();
  });

  it("says Exporting with the job's progress while it runs", async () => {
    render(<Host />);
    await pressExport();
    await waitFor(() =>
      expect(useDawStore.getState().activityJob?.id).toBe("x1"),
    );
    act(() =>
      useDawStore.setState({
        activityJob: { ...EXPORT_STARTED, current: 1, total: 4 },
      }),
    );
    expect(await screen.findByText("Exporting")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "25",
    );
    expect(exportButton()).toBeDisabled();
  });

  it("announces a stall through the shell channel without a toast", async () => {
    render(<Host />);
    await pressExport();
    await waitFor(() =>
      expect(useDawStore.getState().activityJob?.id).toBe("x1"),
    );
    const announce = vi.fn();
    const nowS = () => Date.now() / 1000;
    act(() =>
      useDawStore.setState({
        announceStatus: announce,
        activityJob: { ...EXPORT_STARTED, last_progress_at: nowS() },
      }),
    );
    act(() =>
      useDawStore.setState({
        activityJob: { ...EXPORT_STARTED, last_progress_at: nowS() - 30 },
      }),
    );
    expect(announce).toHaveBeenCalledWith("Progress stalled", {
      toast: false,
    });
    act(() =>
      useDawStore.setState({
        activityJob: { ...EXPORT_STARTED, id: "other" },
      }),
    );
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("speaks no stall for an export whose run is cancelling", async () => {
    render(<Host />);
    await pressExport();
    await waitFor(() =>
      expect(useDawStore.getState().activityJob?.id).toBe("x1"),
    );
    const announce = vi.fn();
    const nowS = () => Date.now() / 1000;
    act(() =>
      useDawStore.setState({
        announceStatus: announce,
        activityJob: { ...EXPORT_STARTED, last_progress_at: nowS() },
      }),
    );
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toBeEnabled());
    await userEvent.click(cancel);
    await waitFor(() => expect(server.cancelRequests).toHaveLength(1));
    act(() =>
      useDawStore.setState({
        activityJob: { ...EXPORT_STARTED, last_progress_at: nowS() - 30 },
      }),
    );
    expect(announce).not.toHaveBeenCalled();
  });

  it("lists the files the folder holds after an export, as downloads in a browser", async () => {
    server.files = [
      {
        id: "ep.mp3",
        name: "ep.mp3",
        kind: "audio",
        label: "Listening file",
        bytes: 5_000_000,
        current: true,
      },
      {
        id: "ep.wav",
        name: "ep.wav",
        kind: "audio",
        label: "Lossless master",
        bytes: 50_000_000,
        current: true,
      },
    ];
    render(<Host />);
    await pressExport();
    await act(async () => server.settle(EXPORT_FINISHED));
    expect(await screen.findByText("Exported")).toBeInTheDocument();
    expect(screen.getByText("Exported 2 files to export/")).toBeInTheDocument();
    expect(
      screen.getByText("Measured −16.1 LUFS, true peak −1.6 dBTP."),
    ).toBeInTheDocument();
    const wav = await screen.findByRole("link", { name: /^Download ep\.wav/ });
    expect(wav.getAttribute("href")).toContain("/api/export/files/ep.wav");
    expect(wav.getAttribute("href")).toContain(encodeURIComponent(PATH));
    expect(
      screen.getByRole("link", { name: /^Download ep\.mp3/ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Reveal|Show in folder/ }),
    ).toBeNull();
    expect(screen.queryByText("Download all")).toBeNull();
    expect(server.fileRequests).toContain(PATH);
  });

  it("asks again with the target the page has now, not the failed attempt's", async () => {
    const appliedAtLufs = (lufs: number) => ({
      ...exportEvidence(null, `target-${lufs}`),
      master_target: { integrated_lufs: lufs, true_peak_db: -1.5, lra: 11 },
    });
    const target = (lufs: number) => {
      server.readSettings = async () =>
        Response.json({ status: "available", settings: appliedAtLufs(lufs) });
      server.config = {
        config: {
          export: { wav: true, formats: [MP3] },
          master: { integrated_lufs: lufs, true_peak_db: -1.5 },
        },
      };
    };
    const revisit = () => {
      act(() => useDawStore.setState({ stage: "edit" }));
      act(() => useDawStore.setState({ stage: "deliver" }));
    };
    render(<Host />);
    await pressExport();
    await act(async () =>
      server.settle({ ...EXPORT_STARTED, status: "error", error: "ffmpeg" }),
    );
    expect(await screen.findByText("Export failed")).toBeInTheDocument();
    target(-14);
    revisit();
    expect(
      await screen.findByText(/Project target preview is −14\.0 LUFS/),
    ).toBeInTheDocument();
    server.reopen();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(server.exportRequests).toHaveLength(2));
    await act(async () =>
      server.settle({
        ...EXPORT_FINISHED,
        result: {
          ...EXPORT_FINISHED.result,
          applied_settings: appliedAtLufs(-14),
        },
      }),
    );
    expect(await screen.findByText("Exported")).toBeInTheDocument();
    target(-16);
    revisit();
    expect(
      await screen.findByText("Export is out of date"),
    ).toBeInTheDocument();
  });

  it("asks again with the formats chosen since the failed attempt", async () => {
    render(<Host />);
    await pressExport();
    await act(async () =>
      server.settle({ ...EXPORT_STARTED, status: "error", error: "ffmpeg" }),
    );
    expect(await screen.findByText("Export failed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^FLAC/ }));
    server.reopen();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(server.exportRequests).toHaveLength(2));
    expect(server.exportRequests[1]).toEqual({
      path: PATH,
      formats: [MP3, { ext: "flac", codec: "flac" }],
    });
    await act(async () => server.settle(EXPORT_FINISHED));
    expect(await screen.findByText("Exported")).toBeInTheDocument();
  });

  it("marks Exported out of date when the loudness target changes afterwards", async () => {
    render(<Host />);
    await pressExport();
    await act(async () => server.settle(EXPORT_FINISHED));
    expect(await screen.findByText("Exported")).toBeInTheDocument();
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
    act(() => useDawStore.setState({ stage: "edit" }));
    act(() => useDawStore.setState({ stage: "deliver" }));
    expect(
      await screen.findByText("Export is out of date"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Exported")).toBeNull();
  });

  it("keeps canonical late-cancel details and exact downloads after an edit or format change", async () => {
    const setHead = (head: string) => {
      const project = useDawStore.getState().project;
      if (!project) throw new Error("fixture");
      act(() =>
        useDawStore.setState({
          project: {
            ...project,
            history: {
              ...project.history,
              head_id: head as HistoryEntryId,
              groups: [
                { kind: "snapshot", id: head, operation: "cut" },
              ] as typeof project.history.groups,
            },
          },
        }),
      );
    };
    setHead("e1");
    server.files = [
      {
        id: "ep.wav",
        name: "ep.wav",
        kind: "audio",
        label: "Lossless master",
        bytes: 128,
        current: true,
        ticket: "wav-ticket",
      },
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
    await pressExport();
    await act(async () =>
      server.settle({
        ...EXPORT_FINISHED,
        status: "cancelled",
        result: { ...EXPORT_FINISHED.result, edit_head_id: "e1" },
      }),
    );
    expect(await screen.findByText("Exported")).toBeInTheDocument();
    expect(screen.queryByText("Edited since export")).toBeNull();
    const expectLateReceipt = async () => {
      expect
        .soft(
          screen.queryByText(
            "Cancel came too late. Exported 2 files to export/",
          ),
        )
        .toBeVisible();
      expect
        .soft(screen.queryByText("Measured −16.1 LUFS, true peak −1.6 dBTP."))
        .toBeVisible();
      expect(
        await screen.findByRole("link", { name: "Download ep.wav, 128 B" }),
      ).toHaveAttribute(
        "href",
        "/api/export/files/ep.wav?path=%2Ftmp%2Fep%2Fepisode.sharecut&ticket=wav-ticket",
      );
      expect(
        await screen.findByRole("link", { name: "Download ep.mp3, 64 B" }),
      ).toHaveAttribute(
        "href",
        "/api/export/files/ep.mp3?path=%2Ftmp%2Fep%2Fepisode.sharecut&ticket=mp3-ticket",
      );
      expect(
        container.querySelector("[data-highlight]"),
      ).not.toBeInTheDocument();
      expect(server.settingsRequests).toEqual([]);
    };
    await expectLateReceipt();

    setHead("e2");
    expect(await screen.findByText("Edited since export")).toBeInTheDocument();
    expect(screen.queryByText("Exported")).toBeNull();
    await expectLateReceipt();

    setHead("e1");
    expect(await screen.findByText("Exported")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^FLAC/ }));
    expect(
      await screen.findByText("Export is out of date"),
    ).toBeInTheDocument();
    await expectLateReceipt();
  });

  it("keeps running when the stage is left and shows the outcome on return", async () => {
    render(<Host />);
    await pressExport();
    act(() => useDawStore.setState({ stage: "edit" }));
    expect(screen.queryByText("Exporting")).toBeNull();
    await act(async () => server.settle(EXPORT_FINISHED));
    act(() => useDawStore.setState({ stage: "deliver" }));
    expect(await screen.findByText("Exported")).toBeInTheDocument();
  });

  it("posts the job id when Cancel is pressed", async () => {
    render(<Host />);
    await pressExport();
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toBeEnabled());
    await userEvent.click(cancel);
    await waitFor(() =>
      expect(server.cancelRequests).toEqual([{ job_id: "x1" }]),
    );
  });

  it("says Export failed with the cause, and Try again goes back to Export", async () => {
    render(<Host />);
    await pressExport();
    await act(async () =>
      server.settle({
        ...EXPORT_STARTED,
        status: "error",
        error: "ffmpeg exited 1",
      }),
    );
    expect(await screen.findByText("Export failed")).toBeInTheDocument();
    expect(screen.getByText("ffmpeg exited 1")).toBeInTheDocument();
    server.reopen();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.queryByText("Export failed")).toBeNull();
    await waitFor(() => expect(server.exportRequests).toHaveLength(2));
    expect(server.exportRequests[1]).toEqual(server.exportRequests[0]);
    expect(await screen.findByText("Exporting")).toBeInTheDocument();
  });

  it("shows the Model need row in the page for a missing model", async () => {
    renderWithModels(<Host />, { status: modelStatus(registryRows()) });
    await pressExport();
    await act(async () => server.settle(EXPORT_MODEL_NEEDED));
    expect(await screen.findByText("Needs noise reduction")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Get noise reduction" }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("holds Export while the settings load and exports nothing", async () => {
    server.holdConfig = new Promise(() => undefined);
    render(<Host />);
    const button = await screen.findAllByRole("button", { name: "Export" });
    expect(button[0]).toBeDisabled();
    expect(button[0]).toHaveAttribute(
      "title",
      "Wait for the settings to load.",
    );
    expect(server.exportRequests).toEqual([]);
  });

  it("shows the command's reason on a disabled Export", async () => {
    asHost("share:abc");
    render(<Host />);
    const button = await screen.findAllByRole("button", { name: "Export" });
    expect(button[0]).toBeDisabled();
    expect(button[0]).toHaveAttribute(
      "title",
      "Host-only (not available on review links)",
    );
  });
});

describe("the export command", () => {
  it("starts the export on Deliver from another stage and asks once", async () => {
    useDawStore.setState({ stage: "edit" });
    render(<Host />);
    expect(await execute("export.deliverables", {})).toEqual({ status: "ok" });
    expect(useDawStore.getState().stage).toBe("deliver");
    await waitFor(() => expect(server.exportRequests).toHaveLength(1));
    expect(useDawStore.getState().chrome.exportRequested).toBe(false);
    await act(async () => server.settle(EXPORT_FINISHED));
    expect(await screen.findByText("Exported")).toBeInTheDocument();
    expect(server.exportRequests).toHaveLength(1);
  });

  it("exports the formats toggled on the page when the command runs", async () => {
    render(<Host />);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /^FLAC/ }));
    expect(await execute("export.deliverables", {})).toEqual({ status: "ok" });
    await waitFor(() => expect(server.exportRequests).toHaveLength(1));
    expect(server.exportRequests[0]).toEqual({
      path: PATH,
      formats: [MP3, { ext: "flac", codec: "flac" }],
    });
  });

  it("starts nothing and clears the request when no format is chosen", async () => {
    server.config = {
      config: {
        export: { wav: false, formats: [] },
        master: { integrated_lufs: -16, true_peak_db: -1.5 },
      },
    };
    render(<Host />);
    await waitFor(() =>
      expect(server.configRequests.length).toBeGreaterThan(0),
    );
    await waitFor(() =>
      expect(exportButton()).toHaveAttribute("title", "Choose a format first."),
    );
    expect(await execute("export.deliverables", {})).toEqual({ status: "ok" });
    await waitFor(() =>
      expect(useDawStore.getState().chrome.exportRequested).toBe(false),
    );
    expect(server.exportRequests).toEqual([]);
    expect(exportButton()).toBeDisabled();
    expect(exportButton()).toHaveAttribute("title", "Choose a format first.");
    expect(screen.queryByText("Exported")).toBeNull();
  });

  it("does not start an export on a later visit when the request was never served", async () => {
    let release!: () => void;
    server.holdConfig = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = render(<Host />);
    await execute("export.deliverables", {});
    await act(async () => undefined);
    view.unmount();
    await waitFor(() =>
      expect(useDawStore.getState().chrome.exportRequested).toBe(false),
    );
    release();
    render(<Host />);
    await ready();
    await act(async () => undefined);
    expect(server.exportRequests).toEqual([]);
  });

  it("waits for this visit's settings, not the ones an earlier visit loaded", async () => {
    useDawStore.setState({ stage: "edit" });
    render(<Host />);
    await waitFor(() => expect(server.configRequests).toHaveLength(1));
    await act(async () => undefined);
    server.config = {
      config: {
        export: { wav: true, formats: [{ ext: "flac", codec: "flac" }] },
        master: { integrated_lufs: -16, true_peak_db: -1.5 },
      },
    };
    let release!: () => void;
    server.holdConfig = new Promise<void>((resolve) => {
      release = resolve;
    });
    await execute("export.deliverables", {});
    await act(async () => undefined);
    expect(server.configRequests).toHaveLength(2);
    expect(server.exportRequests).toEqual([]);
    release();
    await waitFor(() => expect(server.exportRequests).toHaveLength(1));
    expect(server.exportRequests[0]).toEqual({
      path: PATH,
      formats: [{ ext: "flac", codec: "flac" }],
    });
  });

  it("waits for the settings before it starts", async () => {
    let release!: () => void;
    server.holdConfig = new Promise<void>((resolve) => {
      release = resolve;
    });
    render(<Host />);
    await execute("export.deliverables", {});
    await act(async () => undefined);
    expect(server.exportRequests).toEqual([]);
    release();
    await waitFor(() => expect(server.exportRequests).toHaveLength(1));
  });
});
