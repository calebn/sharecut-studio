import { act, render, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  coversRequest,
  type ExportRequest,
} from "../../stages/deliver/deliverLogic";
import { useDawStore } from "../../state/dawStore";
import { deferred } from "../../test/deferred";
import {
  EXPORT_FINISHED,
  EXPORT_MODEL_NEEDED,
  EXPORT_PATH,
  EXPORT_STARTED,
  exportEvidence,
  fakeExportServer,
} from "../../test/fakeExportServer";
import { minimalProject } from "../../test/fixtures";
import {
  modelStatus,
  registryRows,
  renderWithLanding,
} from "../../test/renderWithModels";
import type { HistoryEntryId } from "../../types/project";
import { ExportFlowProvider } from "./exportFlow";
import { type ExportFlow, useExportFlow } from "./exportFlowContext";

const REQUEST: ExportRequest = {
  settings: {
    formats: ["mp3"],
    loudness: "podcast",
    part: { mode: "whole" },
  },
  clips: [],
  chapters: [],
  range: null,
};

const MP3 = { ext: "mp3", codec: "libmp3lame", bitrate_kbps: 128 };

let flow: ExportFlow;
function Probe() {
  const current = useExportFlow();
  useLayoutEffect(() => {
    flow = current;
  });
  return null;
}

let server: ReturnType<typeof fakeExportServer>;

function mount() {
  return render(
    <ExportFlowProvider>
      <Probe />
    </ExportFlowProvider>,
  );
}

async function loaded() {
  await waitFor(() => expect(flow.settings).not.toBeNull());
}

async function running() {
  await waitFor(() => expect(flow.run).toMatchObject({ jobId: "x1" }));
}

describe("the export flow over the server's routes", () => {
  beforeEach(() => {
    server = fakeExportServer();
    useDawStore.setState({
      projectPath: EXPORT_PATH,
      project: minimalProject(),
      guestMode: null,
      stage: "deliver",
      activityJob: null,
      pipelineJob: null,
      jobFeedback: new Map(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("loads the project's formats and selects the configured ones", async () => {
    mount();
    expect(flow.loading).toBe(true);
    await loaded();
    expect(flow.loading).toBe(false);
    expect(flow.settings?.choices.map((c) => c.key)).toEqual([
      "mp3",
      "m4a",
      "flac",
    ]);
    expect(flow.selected).toEqual(["mp3"]);
    expect(flow.run).toEqual({ kind: "idle" });
    expect(server.configRequests).toEqual([EXPORT_PATH]);
  });

  it("keeps the choice when a reload finds the same settings", async () => {
    mount();
    await loaded();
    act(() => flow.setSelected(["mp3", "flac"]));
    void act(() => flow.reload());
    await waitFor(() => expect(server.configRequests).toHaveLength(2));
    expect(flow.selected).toEqual(["mp3", "flac"]);
  });

  it("follows changed configured formats before an operator choice", async () => {
    mount();
    await loaded();
    server.config = {
      config: { export: { wav: false, formats: [{ ext: "flac" }] } },
    };
    void act(() => flow.reload());
    await waitFor(() => expect(flow.selected).toEqual(["flac"]));
    expect(flow.settings?.wav).toBe(false);
  });

  it.each(["alias", "master"])(
    "retains explicit FLAC across a %s catalog refresh",
    async (change) => {
      mount();
      await loaded();
      act(() => flow.setSelected(["flac"]));
      server.config = {
        config: {
          export: {
            formats: [
              change === "alias"
                ? { extension: ".MP3", codec: "libmp3lame", bitrate_kbps: 128 }
                : MP3,
            ],
          },
          master: {
            integrated_lufs: change === "master" ? -18 : -16,
            true_peak_db: -1.5,
          },
        },
      };
      act(() => {
        flow.reload();
      });
      await waitFor(() => expect(flow.loadedGeneration).toBe(1));
      expect(flow.selected).toEqual(["flac"]);
      act(() => flow.start(flow.selected, REQUEST));
      await running();
      expect(server.exportRequests).toEqual([
        { path: EXPORT_PATH, formats: [{ ext: "flac", codec: "flac" }] },
      ]);
    },
  );

  it.each([{ keys: ["opus"] }, { keys: ["mp3", "opus"] }])(
    "retains missing intent $keys and refuses fresh partial export with WAV enabled",
    async ({ keys }) => {
      server.config = {
        config: {
          export: { formats: [MP3, { ext: "opus", codec: "libopus" }] },
        },
      };
      mount();
      await loaded();
      act(() => flow.setSelected(keys));
      server.config = { config: { export: { wav: true, formats: [MP3] } } };
      act(() => {
        flow.reload();
      });
      await waitFor(() => expect(flow.loadedGeneration).toBe(1));
      act(() => flow.start(keys, REQUEST));
      expect(flow.run).toEqual({ kind: "idle" });
      expect(flow.selected).toEqual(keys);
      expect(server.exportRequests).toEqual([]);
      act(() => {
        flow.setSelected([]);
        flow.start([], REQUEST);
      });
      await running();
      expect(server.exportRequests).toEqual([
        { path: EXPORT_PATH, formats: [] },
      ]);
    },
  );

  it("cannot recertify an export by filtering missing intent and restores it with a fresh read", async () => {
    server.config = {
      config: { export: { formats: [MP3, { ext: "opus", codec: "libopus" }] } },
    };
    mount();
    await loaded();
    act(() => flow.setSelected(["mp3"]));
    await completeCanonical();
    await waitFor(() => expect(flow.settingsStatus).toBe("match"));
    act(() => flow.setSelected(["mp3", "opus"]));
    expect(flow.settingsStatus).toBe("different");
    expect(flow.selected).toEqual(["mp3", "opus"]);
    server.config = { config: { export: { wav: true, formats: [MP3] } } };
    act(() => {
      flow.reload();
    });
    await waitFor(() => expect(flow.loadedGeneration).toBe(1));
    expect(flow.selected).toEqual(["mp3", "opus"]);
    expect(flow.settingsStatus).toBe("different");
    act(() => flow.setSelected(["mp3"]));
    await waitFor(() => expect(flow.settingsStatus).toBe("match"));
    server.config = { config: { export: { wav: true, formats: [] } } };
    act(() => {
      flow.reload();
    });
    await waitFor(() => expect(flow.loadedGeneration).toBe(2));
    expect(flow.selected).toEqual(["mp3"]);
    expect(flow.settingsStatus).toBe("different");
    const reads = server.settingsRequests.length;
    server.config = { config: { export: { wav: true, formats: [MP3] } } };
    act(() => {
      flow.reload();
    });
    await waitFor(() => expect(flow.settingsStatus).toBe("match"));
    expect(server.settingsRequests).toHaveLength(reads + 1);
    expect(server.settingsRequests.at(-1)?.body).toEqual({
      path: EXPORT_PATH,
      formats: [MP3],
    });
    expect(flow.selected).toEqual(["mp3"]);
  });

  it("uses the latest raw encoders for a fresh start after explicit choice survives refresh", async () => {
    mount();
    await loaded();
    act(() => flow.setSelected(["mp3"]));
    const raw = {
      extension: ".MP3",
      codec: "libmp3lame",
      bitrate_kbps: 192,
      encoder_options: { mode: "joint" },
    };
    server.config = { config: { export: { formats: [raw] } } };
    act(() => {
      flow.reload();
    });
    await waitFor(() => expect(flow.loadedGeneration).toBe(1));
    expect(flow.selected).toEqual(["mp3"]);
    act(() => flow.start(flow.selected, REQUEST));
    await running();
    expect(server.exportRequests).toEqual([
      { path: EXPORT_PATH, formats: [raw] },
    ]);
  });

  it("reports why the settings did not load, and loads them again on Try again", async () => {
    server.configAnswer = { status: 500, body: { detail: "offline" } };
    mount();
    await waitFor(() => expect(flow.settingsError).not.toBeNull());
    expect(flow.loading).toBe(false);
    expect(flow.settings).toBeNull();

    server.configAnswer = null;
    act(() => flow.again());
    await loaded();
    expect(flow.settingsError).toBeNull();
  });

  it("posts the chosen formats to the export route and follows the job to its files", async () => {
    mount();
    await loaded();
    act(() => flow.setSelected(["mp3", "flac"]));
    act(() => flow.start(flow.selected, REQUEST));

    expect(flow.run).toEqual({
      kind: "running",
      jobId: null,
      cancelling: false,
      cancelError: null,
    });
    await running();
    expect(server.exportRequests).toEqual([
      {
        path: EXPORT_PATH,
        formats: [MP3, { ext: "flac", codec: "flac" }],
      },
    ]);
    expect(flow.selected).toEqual(["mp3", "flac"]);
    const admitted = {
      ...REQUEST,
      settings: { ...REQUEST.settings, formats: ["mp3", "flac"] },
    };
    expect(flow.request).toEqual(admitted);
    expect(
      coversRequest(admitted, { ...admitted, settings: REQUEST.settings }),
    ).toBe(false);

    vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
    await act(async () => server.settle(EXPORT_FINISHED));
    await waitFor(() => expect(flow.run.kind).toBe("done"));
    expect(flow.request).toEqual(admitted);
    expect(flow.run).toEqual({
      kind: "done",
      receipt: {
        kind: "canonical",
        appliedSettings: { basis: "default", target: null },
        paths: ["/tmp/ep/export/ep.wav", "/tmp/ep/export/ep.mp3"],
        master: { measured: { integrated_lufs: -16.1, true_peak_db: -1.6 } },
      },
      finishedAt: Date.parse("2026-01-02T03:04:05Z"),
    });
  });

  const available = (basis = "default") =>
    Response.json({
      status: "available",
      settings: exportEvidence(null, basis),
    });

  async function completeCanonical() {
    act(() => flow.start(flow.selected, REQUEST));
    await running();
    await act(async () => server.settle(EXPORT_FINISHED));
    expect(flow.run).toMatchObject({
      kind: "done",
      receipt: { kind: "canonical" },
    });
  }

  it("revokes a matching read at reload start and rejects an older success after the newest read fails", async () => {
    mount();
    await loaded();
    await completeCanonical();
    await waitFor(() => expect(flow.settingsStatus).toBe("match"));

    const catalog = deferred();
    const earlier = deferred<Response>();
    const latest = deferred<Response>();
    server.holdConfig = catalog.promise;
    server.readSettings = () => earlier.promise;
    act(() => {
      flow.reload();
    });
    expect(flow.settingsStatus).toBe("unknown");
    expect(server.settingsRequests).toHaveLength(1);
    server.holdConfig = null;
    await act(async () => catalog.resolve());
    await waitFor(() => expect(server.settingsRequests).toHaveLength(2));

    server.readSettings = () => latest.promise;
    act(() => {
      flow.reload();
    });
    await waitFor(() => expect(server.settingsRequests).toHaveLength(3));
    expect(server.settingsRequests[1].signal?.aborted).toBe(true);

    await act(async () => latest.resolve(new Response(null, { status: 503 })));
    expect(flow.settingsStatus).toBe("unknown");
    await act(async () => earlier.resolve(available()));
    expect(flow.settingsStatus).toBe("unknown");
    expect(flow.run).toMatchObject({
      kind: "done",
      receipt: { paths: ["/tmp/ep/export/ep.wav", "/tmp/ep/export/ep.mp3"] },
    });
    expect(server.exportRequests).toEqual([
      { path: EXPORT_PATH, formats: [MP3] },
    ]);
  });

  it("requires a fresh answer after a batched selection departure and restoration", async () => {
    const earlier = deferred<Response>();
    const latest = deferred<Response>();
    server.readSettings = () => earlier.promise;
    mount();
    await loaded();
    await completeCanonical();
    await waitFor(() => expect(server.settingsRequests).toHaveLength(1));

    server.readSettings = () => latest.promise;
    act(() => {
      flow.setSelected(["mp3", "flac"]);
      flow.setSelected(["mp3"]);
    });
    await waitFor(() => expect(server.settingsRequests).toHaveLength(2));
    expect(server.settingsRequests[0].signal?.aborted).toBe(true);
    await act(async () => latest.resolve(available("latest")));
    expect(flow.settingsStatus).toBe("different");
    await act(async () => earlier.resolve(available()));
    expect(flow.settingsStatus).toBe("different");
    expect(server.settingsRequests.map(({ body }) => body)).toEqual([
      { path: EXPORT_PATH, formats: [MP3] },
      { path: EXPORT_PATH, formats: [MP3] },
    ]);
  });

  it("discards a late settings reply after a path and epoch ABA", async () => {
    const earlier = deferred<Response>();
    server.readSettings = () => earlier.promise;
    mount();
    await loaded();
    await completeCanonical();
    await waitFor(() => expect(server.settingsRequests).toHaveLength(1));

    const store = useDawStore.getState();
    act(() => {
      store.hydrate("/tmp/other/episode.sharecut", minimalProject());
      store.hydrate(EXPORT_PATH, minimalProject());
      useDawStore.setState({ stage: "deliver" });
    });
    expect(useDawStore.getState().projectEpoch).toBeGreaterThan(
      store.projectEpoch,
    );
    expect(server.settingsRequests[0].signal?.aborted).toBe(true);
    await loaded();
    expect(flow.run).toEqual({ kind: "idle" });
    server.reopen();
    server.started = { ...EXPORT_STARTED, id: "new-owner" };
    server.readSettings = async () => available("new-owner");
    act(() => flow.start(flow.selected, REQUEST));
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "new-owner" }));
    await act(async () =>
      server.settle({ ...EXPORT_FINISHED, id: "new-owner" }),
    );
    await waitFor(() => expect(flow.settingsStatus).toBe("different"));
    await act(async () => earlier.resolve(available()));
    expect(flow.settingsStatus).toBe("different");
    expect(flow.run).toMatchObject({
      kind: "done",
      receipt: { appliedSettings: { basis: "default", target: null } },
    });
    expect(server.settingsRequests).toHaveLength(2);
  });

  it("uses the original request order after distinct destinations move in the catalog", async () => {
    const flac = { ext: "flac", codec: "flac" };
    server.config = { config: { export: { formats: [MP3, flac] } } };
    mount();
    await loaded();
    await completeCanonical();
    await waitFor(() => expect(flow.settingsStatus).toBe("match"));

    server.config = { config: { export: { formats: [flac, MP3] } } };
    act(() => {
      flow.reload();
    });
    await waitFor(() => expect(flow.settingsStatus).toBe("match"));
    expect(flow.selected).toEqual(["flac", "mp3"]);
    expect(server.settingsRequests.map(({ body }) => body)).toEqual([
      { path: EXPORT_PATH, formats: [MP3, flac] },
      { path: EXPORT_PATH, formats: [MP3, flac] },
    ]);
  });

  it("keeps a canonical receipt current when only the extension alias changes", async () => {
    const original = { extension: ".MP3", bitrate_kbps: 128 };
    server.config = { config: { export: { formats: [original] } } };
    mount();
    await loaded();
    await completeCanonical();
    await waitFor(() => expect(flow.settingsStatus).toBe("match"));

    server.config = {
      config: { export: { formats: [{ ext: "mp3", bitrate_kbps: 128 }] } },
    };
    act(() => {
      flow.reload();
    });
    await waitFor(() => expect(flow.loadedGeneration).toBe(1));
    expect
      .soft(flow.settings?.choices[0].spec)
      .toEqual({ ext: "mp3", bitrate_kbps: 128 });
    expect.soft(flow.selected).toEqual(["mp3"]);
    await waitFor(() => expect(flow.settingsStatus).toBe("match"));
    const request = { path: EXPORT_PATH, formats: [original] };
    expect(server.exportRequests).toEqual([request]);
    expect(server.settingsRequests.map(({ body }) => body)).toEqual([
      request,
      request,
    ]);
  });

  it.each([
    {
      name: "matching ext and extension aliases",
      original: { ext: ".MP3", extension: "mp3", bitrate_kbps: 128 },
    },
    {
      name: "an empty ext with an extension alias",
      original: { ext: "", extension: "mp3", bitrate_kbps: 128 },
    },
  ])(
    "keeps the applied settings current after reloading $name",
    async ({ original }) => {
      server.config = { config: { export: { formats: [original] } } };
      mount();
      await loaded();
      await completeCanonical();
      await waitFor(() => expect(flow.settingsStatus).toBe("match"));

      server.config = {
        config: { export: { formats: [{ ext: "mp3", bitrate_kbps: 128 }] } },
      };
      act(() => {
        flow.reload();
      });
      await waitFor(() => expect(flow.loadedGeneration).toBe(1));
      expect.soft(flow.settingsStatus).toBe("match");

      const request = { path: EXPORT_PATH, formats: [original] };
      expect.soft(flow.selected).toEqual(["mp3"]);
      expect(server.exportRequests).toEqual([request]);
      expect(server.settingsRequests.map(({ body }) => body)).toEqual([
        request,
        request,
      ]);
    },
  );

  it("detects and restores a WAV-only producer basis change", async () => {
    const config = (wav: boolean) => ({
      config: { export: { wav, formats: [MP3] } },
    });
    server.config = config(true);
    server.readSettings = async () =>
      Response.json({
        status: "available",
        settings: {
          ...exportEvidence(null, "with-wav"),
          audio_formats: ["wav", "mp3"],
        },
      });
    mount();
    await loaded();
    act(() => flow.start(flow.selected, REQUEST));
    await running();
    await act(async () =>
      server.settle({
        ...EXPORT_FINISHED,
        result: {
          ...EXPORT_FINISHED.result,
          applied_settings: exportEvidence(null, "with-wav"),
        },
      }),
    );
    await waitFor(() => expect(flow.settingsStatus).toBe("match"));

    const changed = deferred<Response>();
    server.config = config(false);
    server.readSettings = () => changed.promise;
    act(() => {
      flow.reload();
    });
    await waitFor(() => expect(server.settingsRequests).toHaveLength(2));
    expect(flow.settingsStatus).toBe("unknown");
    await act(async () =>
      changed.resolve(
        Response.json({
          status: "available",
          settings: {
            ...exportEvidence(null, "mp3-only"),
            audio_formats: ["mp3"],
          },
        }),
      ),
    );
    expect(flow.settingsStatus).toBe("different");

    const restored = deferred<Response>();
    server.config = config(true);
    server.readSettings = () => restored.promise;
    act(() => {
      flow.reload();
    });
    await waitFor(() => expect(server.settingsRequests).toHaveLength(3));
    expect(flow.settingsStatus).toBe("unknown");
    await act(async () =>
      restored.resolve(
        Response.json({
          status: "available",
          settings: exportEvidence(null, "with-wav"),
        }),
      ),
    );
    expect(flow.settingsStatus).toBe("match");
    expect(flow.run).toMatchObject({
      kind: "done",
      receipt: { appliedSettings: { basis: "with-wav", target: null } },
    });
    const request = { path: EXPORT_PATH, formats: [MP3] };
    expect(server.exportRequests).toEqual([request]);
    expect(server.settingsRequests.map(({ body }) => body)).toEqual([
      request,
      request,
      request,
    ]);
  });

  it("leaves cached explicit choices uncertified after a failed catalog reload", async () => {
    mount();
    await loaded();
    await completeCanonical();
    await waitFor(() => expect(flow.settingsStatus).toBe("match"));
    server.configAnswer = { status: 503, body: { detail: "offline" } };
    act(() => {
      flow.reload();
    });
    await waitFor(() => expect(flow.settingsError).toBe("offline"));
    expect(flow.settingsStatus).toBe("unknown");
    expect(flow.selected).toEqual(["mp3"]);
    expect(flow.run.kind).toBe("done");
    expect(server.settingsRequests).toHaveLength(1);
  });

  it("checks a successful implicit export after the initial catalog fails and later recovers", async () => {
    server.configAnswer = { status: 503, body: { detail: "offline" } };
    mount();
    await waitFor(() => expect(flow.settingsError).toBe("offline"));
    await completeCanonical();
    await waitFor(() => expect(flow.settingsStatus).toBe("match"));
    expect(server.exportRequests).toEqual([
      { path: EXPORT_PATH, formats: null },
    ]);

    server.configAnswer = null;
    act(() => {
      flow.reload();
    });
    await loaded();
    await waitFor(() => expect(flow.settingsStatus).toBe("match"));
    expect(flow.selected).toEqual(["mp3"]);
    act(() => flow.setSelected(["mp3", "flac"]));
    expect(flow.settingsStatus).toBe("different");
    act(() => flow.setSelected(["mp3"]));
    await waitFor(() => expect(flow.settingsStatus).toBe("match"));
    expect(server.settingsRequests.map(({ body }) => body)).toEqual([
      { path: EXPORT_PATH, formats: null },
      { path: EXPORT_PATH, formats: null },
      { path: EXPORT_PATH, formats: null },
    ]);
  });

  it.each([
    { projectPath: "share:review", guestMode: null },
    { projectPath: "record:recording", guestMode: null },
    { projectPath: EXPORT_PATH, guestMode: "view" },
  ])(
    "never queries the host catalog or starts a job for $projectPath ($guestMode)",
    async (audience) => {
      useDawStore.setState(audience);
      mount();
      await act(async () => flow.start(["mp3"], REQUEST));
      expect(flow.run).toEqual({ kind: "idle" });
      expect(server.configRequests).toEqual([]);
      expect(server.exportRequests).toEqual([]);
      expect(server.settingsRequests).toEqual([]);
    },
  );

  it("announces what the finished export wrote", async () => {
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await running();
    await act(async () => server.settle(EXPORT_FINISHED));
    await waitFor(() => expect(flow.run.kind).toBe("done"));
    expect(useDawStore.getState().jobFeedback).toEqual(
      new Map([
        [
          "x1",
          {
            kind: "ready",
            outcome: { kind: "verified", copy: "Exported 2 files to export/" },
          },
        ],
      ]),
    );
  });

  it("ignores a second start in the same tick", async () => {
    mount();
    await loaded();
    act(() => {
      flow.start(["mp3"], REQUEST);
      flow.start(["mp3"], REQUEST);
    });
    await running();
    expect(server.exportRequests).toHaveLength(1);
  });

  it("ignores a second start while one runs", async () => {
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    act(() => flow.start(["mp3"], REQUEST));
    await running();
    expect(server.exportRequests).toHaveLength(1);
  });

  it("exports with the project's saved formats when its settings did not load", async () => {
    server.configAnswer = { status: 500, body: { detail: "offline" } };
    mount();
    await waitFor(() => expect(flow.settingsError).not.toBeNull());
    act(() => flow.start([], REQUEST));
    await running();
    expect(server.exportRequests).toEqual([
      { path: EXPORT_PATH, formats: null },
    ]);
  });

  it("defers to saved formats when the settings response contains an unreadable record", async () => {
    server.config = { config: { export: { formats: [{ codec: "flac" }] } } };
    mount();
    await waitFor(() => expect(flow.loading).toBe(false));
    expect
      .soft(flow.settingsError)
      .toBe("Could not read the configured export formats");
    expect.soft(flow.settings).toBeNull();
    act(() => flow.start(flow.selected, REQUEST));
    await running();
    expect(server.exportRequests).toEqual([
      { path: EXPORT_PATH, formats: null },
    ]);
  });

  it("covers the history head the export started from, not the one at the click", async () => {
    const answer = deferred();
    server.holdStart = answer.promise;
    mount();
    await loaded();
    act(() => flow.start(["mp3"], { ...REQUEST, edits: "before" }));
    act(() => {
      const project = useDawStore.getState().project;
      if (project)
        useDawStore.setState({
          project: {
            ...project,
            history: {
              ...project.history,
              head_id: "after" as HistoryEntryId,
              groups: [{ kind: "snapshot", id: "after", operation: "cut" }],
            },
          },
        });
    });
    answer.resolve();
    await running();
    expect(flow.request?.edits).toBe("after");
  });

  it("takes the edit head from the finished job", async () => {
    mount();
    await loaded();
    act(() => flow.start(["mp3"], { ...REQUEST, edits: "clicked" }));
    await running();
    await act(async () =>
      server.settle({
        ...EXPORT_FINISHED,
        result: { ...EXPORT_FINISHED.result, edit_head_id: "exported" },
      }),
    );
    await waitFor(() => expect(flow.run.kind).toBe("done"));
    expect(flow.request?.edits).toBe("exported");
  });

  it("does not cancel before the server has answered the start", async () => {
    const answer = deferred();
    server.holdStart = answer.promise;
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    act(() => flow.cancel());
    expect(server.cancelRequests).toEqual([]);
    expect(flow.run).toMatchObject({ kind: "running", cancelling: false });
    answer.resolve();
    await running();
  });

  it("cancels the running job, then ends cancelled with nothing written", async () => {
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await running();

    act(() => flow.cancel());
    expect(flow.run).toMatchObject({ cancelling: true, cancelError: null });
    await waitFor(() =>
      expect(server.cancelRequests).toEqual([{ job_id: "x1" }]),
    );

    await act(async () =>
      server.settle({ ...EXPORT_STARTED, status: "cancelled" }),
    );
    await waitFor(() => expect(flow.run.kind).toBe("cancelled"));
    expect(flow.run).toEqual({
      kind: "cancelled",
      receipt: null,
      finishedAt: expect.any(Number),
    });
    expect(useDawStore.getState().jobFeedback).toEqual(new Map([]));
    act(() => flow.again());
    expect(flow.run).toEqual({ kind: "idle" });
    expect(server.exportRequests).toHaveLength(1);
  });

  it("never posts an empty format list, even after a reload failed", async () => {
    server.config = {
      config: {
        export: { wav: false, formats: [{ ext: "mp3" }] },
        master: { integrated_lufs: -16, true_peak_db: -1.5 },
      },
    };
    mount();
    await loaded();
    act(() => flow.setLoudness("streaming"));
    act(() => flow.start([], REQUEST));
    expect(flow.run).toEqual({ kind: "idle" });
    expect(flow.loudness).toBe("streaming");

    server.configAnswer = { status: 500, body: { detail: "offline" } };
    act(() => void flow.reload());
    await waitFor(() => expect(flow.settingsError).not.toBeNull());
    expect(flow.settings).not.toBeNull();
    act(() => flow.start([], REQUEST));
    expect(flow.run).toEqual({ kind: "idle" });
    expect(flow.loudness).toBe("streaming");
    await act(async () => undefined);
    expect(server.exportRequests).toEqual([]);
    act(() => flow.start(["mp3"], REQUEST));
    await running();
    expect(flow.loudness).toBeNull();
    expect(server.exportRequests).toEqual([
      { path: EXPORT_PATH, formats: [{ ext: "mp3" }] },
    ]);
  });

  it("counts a settings load as finished whether or not it worked", async () => {
    mount();
    await loaded();
    server.configAnswer = { status: 500, body: { detail: "offline" } };
    let wanted = 0;
    act(() => {
      wanted = flow.reload();
    });
    expect(wanted).toBeGreaterThan(0);
    await waitFor(() =>
      expect(flow.loadedGeneration).toBeGreaterThanOrEqual(wanted),
    );
  });

  it("keeps the files a cancel arrived too late to stop", async () => {
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await running();
    await act(async () =>
      server.settle({ ...EXPORT_FINISHED, status: "cancelled" }),
    );
    await waitFor(() => expect(flow.run.kind).toBe("cancelled"));
    expect(server.settingsRequests).toEqual([]);
    expect(flow.settingsStatus).toBe("unknown");
    expect(flow.run).toEqual({
      kind: "cancelled",
      receipt: {
        kind: "canonical",
        appliedSettings: null,
        paths: ["/tmp/ep/export/ep.wav", "/tmp/ep/export/ep.mp3"],
        master: { measured: { integrated_lufs: -16.1, true_peak_db: -1.6 } },
      },
      finishedAt: expect.any(Number),
    });
    expect(useDawStore.getState().jobFeedback).toEqual(
      new Map([
        [
          "x1",
          {
            kind: "ready",
            outcome: {
              kind: "verified",
              copy: "Cancel came too late. Exported 2 files to export/",
            },
          },
        ],
      ]),
    );
  });

  it("takes the edit head from a job whose cancel came too late", async () => {
    mount();
    await loaded();
    act(() => flow.start(["mp3"], { ...REQUEST, edits: "clicked" }));
    await running();
    await act(async () =>
      server.settle({
        ...EXPORT_FINISHED,
        status: "cancelled",
        result: { ...EXPORT_FINISHED.result, edit_head_id: "exported" },
      }),
    );
    await waitFor(() => expect(flow.run.kind).toBe("cancelled"));
    expect(flow.request?.edits).toBe("exported");
  });

  it("preserves a null named receipt head instead of the requested head", async () => {
    mount();
    await loaded();
    act(() =>
      flow.start(["mp3"], {
        ...REQUEST,
        edits: "requested-head",
        namedTarget: "broadcast",
      }),
    );
    await running();
    await act(async () =>
      server.settle({
        ...EXPORT_FINISHED,
        result: {
          target: "broadcast",
          file_ids: ["opaque-export"],
          edit_head_id: null,
          master: {
            within_tolerance: true,
            measured: { integrated_lufs: -23.1, true_peak_db: -1.6 },
          },
        },
      }),
    );

    await waitFor(() => expect(flow.run.kind).toBe("done"));
    expect(flow.request?.edits).toBeNull();
    expect(flow.run).toMatchObject({
      kind: "done",
      receipt: {
        kind: "named",
        fileIds: ["opaque-export"],
        editHeadId: null,
        master: { measured: { integrated_lufs: -23.1 } },
      },
    });
  });

  it("says why a cancel failed and lets it be tried again", async () => {
    server.cancelAnswer = { status: 500, body: { detail: "gone" } };
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await running();
    act(() => flow.cancel());
    await waitFor(() => expect(flow.run).toMatchObject({ cancelling: false }));
    expect((flow.run as { cancelError: string }).cancelError).toContain("gone");
  });

  it("ignores an old cancel failure while the next export is cancelling", async () => {
    const oldCancel = deferred<Response>();
    const nextCancel = deferred<Response>();
    const fetchRoute = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (
          typeof input === "string" &&
          input.includes("/api/pipeline/cancel")
        ) {
          server.cancelRequests.push(JSON.parse(init?.body as string));
          return server.cancelRequests.length === 1
            ? oldCancel.promise
            : nextCancel.promise;
        }
        return fetchRoute(input, init);
      }),
    );
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await running();
    act(() => flow.cancel());
    await waitFor(() =>
      expect(server.cancelRequests).toEqual([{ job_id: "x1" }]),
    );
    await act(async () =>
      server.settle({ ...EXPORT_STARTED, status: "cancelled" }),
    );
    await waitFor(() => expect(flow.run.kind).toBe("cancelled"));

    server.reopen();
    server.started = { ...EXPORT_STARTED, id: "x2" };
    act(() => flow.again());
    act(() => flow.start(["mp3"], REQUEST));
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "x2" }));
    act(() => flow.cancel());
    expect(server.cancelRequests).toEqual([{ job_id: "x1" }, { job_id: "x2" }]);
    expect(flow.run).toMatchObject({ cancelling: true, cancelError: null });

    await act(async () => oldCancel.reject(new Error("old cancel refused")));
    expect(flow.run).toMatchObject({
      kind: "running",
      jobId: "x2",
      cancelling: true,
      cancelError: null,
    });

    await act(async () =>
      nextCancel.reject(new Error("current cancel refused")),
    );
    expect(flow.run).toMatchObject({
      kind: "running",
      jobId: "x2",
      cancelling: false,
      cancelError: "current cancel refused",
    });
  });

  it("names a failure", async () => {
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await running();
    await act(async () =>
      server.settle({
        ...EXPORT_STARTED,
        status: "error",
        error: "ffmpeg exited 1",
      }),
    );
    await waitFor(() =>
      expect(flow.run).toEqual({ kind: "failed", reason: "ffmpeg exited 1" }),
    );
  });

  it("follows the job through the Activity snapshot", async () => {
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await running();
    expect(flow.job).toEqual(useDawStore.getState().activityJob);
    expect(flow.job?.id).toBe("x1");
    act(() =>
      useDawStore.setState({ activityJob: { ...EXPORT_STARTED, id: "other" } }),
    );
    expect(flow.job).toBeNull();
  });

  it("returns to idle and announces nothing when the project changes", async () => {
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await running();

    act(() => useDawStore.setState({ projectPath: "/tmp/other.project.json" }));
    await waitFor(() => expect(flow.run).toEqual({ kind: "idle" }));
    expect(useDawStore.getState().jobFeedback).toEqual(
      new Map([["x1", { kind: "unverified" }]]),
    );
    expect(flow.request).toBeNull();
    await waitFor(() =>
      expect(server.configRequests).toContain("/tmp/other.project.json"),
    );
  });

  it("forgets a finished export when the project changes", async () => {
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await running();
    await act(async () => server.settle(EXPORT_FINISHED));
    await waitFor(() => expect(flow.run.kind).toBe("done"));

    act(() => useDawStore.setState({ projectPath: "/tmp/other.project.json" }));
    await waitFor(() => expect(flow.run).toEqual({ kind: "idle" }));
    expect(flow.request).toBeNull();
  });

  describe("model need", () => {
    const mountNeeding = () =>
      renderWithLanding(
        <ExportFlowProvider>
          <Probe />
        </ExportFlowProvider>,
        { status: modelStatus(registryRows()) },
      );
    const startAndNeedModel = async () => {
      const view = mountNeeding();
      await loaded();
      act(() => flow.start(["mp3"], REQUEST));
      await running();
      await act(async () => server.settle(EXPORT_MODEL_NEEDED));
      return view;
    };

    it("holds the export on Deliver and exports again by itself when the model lands", async () => {
      const { land, api } = await startAndNeedModel();
      await waitFor(() => expect(flow.needs?.id).toBe("rnnoise"));
      expect(flow.run).toEqual({ kind: "idle" });
      expect(server.exportRequests).toHaveLength(1);

      server.reopen();
      land("rnnoise");
      await waitFor(() => expect(server.exportRequests).toHaveLength(2));
      await act(async () => server.settle(EXPORT_FINISHED));
      await waitFor(() => expect(flow.run.kind).toBe("done"));
      expect(flow.needs).toBeNull();
      expect(api.download).not.toHaveBeenCalled();
    });

    it("resumes the submitted target and resolved formats after the model lands", async () => {
      const raw = { extension: ".MP3", codec: "libmp3lame", bitrate_kbps: 128 };
      server.config = { config: { export: { formats: [raw] } } };
      const { land } = mountNeeding();
      await loaded();
      act(() => flow.start(["mp3"], { ...REQUEST, namedTarget: "broadcast" }));
      await running();
      await act(async () => server.settle(EXPORT_MODEL_NEEDED));
      await waitFor(() => expect(flow.needs?.id).toBe("rnnoise"));

      server.config = {
        config: { export: { formats: [{ ext: "mp3", bitrate_kbps: 96 }] } },
      };
      act(() => {
        flow.setLoudness("streaming");
        flow.reload();
      });
      await waitFor(() =>
        expect(flow.settings?.choices[0]?.spec.bitrate_kbps).toBe(96),
      );
      server.reopen();
      land("rnnoise");
      await waitFor(() =>
        expect(server.exportRequests).toEqual([
          { path: EXPORT_PATH, formats: [raw], target: "broadcast" },
          { path: EXPORT_PATH, formats: [raw], target: "broadcast" },
        ]),
      );
      expect(flow.loudness).toBe("streaming");
      await act(async () =>
        server.settle({
          ...EXPORT_FINISHED,
          result: {
            target: "broadcast",
            file_ids: ["opaque-export"],
            master: {
              within_tolerance: true,
              measured: { integrated_lufs: -23.2, true_peak_db: -1.4 },
            },
            edit_head_id: null,
          },
        }),
      );
      await waitFor(() =>
        expect(flow.run).toMatchObject({
          kind: "done",
          receipt: {
            kind: "named",
            target: "broadcast",
            fileIds: ["opaque-export"],
          },
        }),
      );
      expect(useDawStore.getState().jobFeedback).toEqual(
        new Map([
          [
            "x1",
            {
              kind: "ready",
              outcome: {
                kind: "verified",
                copy: "Exported 1 Broadcast audio file.",
              },
            },
          ],
        ]),
      );
    });

    it("retries a frozen removed encoder but refuses a fresh operation until removal", async () => {
      const raw = { extension: ".OPUS", codec: "libopus", bitrate_kbps: 96 };
      server.config = { config: { export: { formats: [raw] } } };
      const { land } = mountNeeding();
      await loaded();
      act(() => {
        flow.setSelected(["opus"]);
        flow.start(["opus"], REQUEST);
      });
      await running();
      await act(async () => server.settle(EXPORT_MODEL_NEEDED));
      await waitFor(() => expect(flow.needs?.id).toBe("rnnoise"));
      server.config = { config: { export: { wav: true, formats: [MP3] } } };
      act(() => {
        flow.reload();
      });
      await waitFor(() => expect(flow.loadedGeneration).toBe(1));
      server.reopen();
      server.started = { ...EXPORT_STARTED, id: "removed-retry" };
      land("rnnoise");
      await waitFor(() =>
        expect(flow.run).toMatchObject({ jobId: "removed-retry" }),
      );
      await act(async () =>
        server.settle({ ...EXPORT_FINISHED, id: "removed-retry" }),
      );
      expect(flow.selected).toEqual(["opus"]);
      expect(flow.settingsStatus).toBe("different");
      act(() => flow.start(flow.selected, REQUEST));
      expect(server.exportRequests).toEqual([
        { path: EXPORT_PATH, formats: [raw] },
        { path: EXPORT_PATH, formats: [raw] },
      ]);
    });

    it("reuses implicit defaults for model resume and its observation after the catalog recovers", async () => {
      server.configAnswer = { status: 503, body: { detail: "offline" } };
      const { land } = mountNeeding();
      await waitFor(() => expect(flow.settingsError).toBe("offline"));
      act(() => flow.start([], REQUEST));
      await running();
      await act(async () => server.settle(EXPORT_MODEL_NEEDED));
      await waitFor(() => expect(flow.needs?.id).toBe("rnnoise"));

      server.configAnswer = null;
      act(() => {
        flow.reload();
      });
      await loaded();
      expect(flow.selected).toEqual(["mp3"]);
      server.reopen();
      server.started = { ...EXPORT_STARTED, id: "implicit-resume" };
      land("rnnoise");
      await waitFor(() =>
        expect(flow.run).toMatchObject({ jobId: "implicit-resume" }),
      );
      await act(async () =>
        server.settle({ ...EXPORT_FINISHED, id: "implicit-resume" }),
      );
      await waitFor(() => expect(flow.settingsStatus).toBe("match"));
      const payload = { path: EXPORT_PATH, formats: null };
      expect(server.exportRequests).toEqual([payload, payload]);
      expect(server.settingsRequests.map(({ body }) => body)).toEqual([
        payload,
      ]);
    });

    it("keeps waiting while the model is still missing", async () => {
      await startAndNeedModel();
      await waitFor(() => expect(flow.needs).not.toBeNull());
      await act(async () => {});
      expect(server.exportRequests).toHaveLength(1);
      expect(flow.run).toEqual({ kind: "idle" });
    });

    it.each(["other-project", "reopened-project"])(
      "retires an old export when model arrival coincides with %s hydration",
      async (replacement) => {
        const { land } = await startAndNeedModel();
        await waitFor(() => expect(flow.needs).not.toBeNull());
        server.reopen();
        try {
          act(() => {
            const store = useDawStore.getState();
            store.hydrate("/tmp/other.project.json", minimalProject());
            if (replacement === "reopened-project") {
              useDawStore.getState().hydrate(EXPORT_PATH, minimalProject());
            }
            useDawStore.setState({ stage: "deliver" });
            land("rnnoise");
          });
          await act(async () => {});
          expect(server.exportRequests.map((request) => request.path)).toEqual([
            EXPORT_PATH,
          ]);
          expect(flow.needs).toBeNull();
          expect(flow.run).toEqual({ kind: "idle" });
        } finally {
          await act(async () => server.settle(EXPORT_FINISHED));
        }
      },
    );

    it("retires the waiting export when the same path is reopened before model arrival", async () => {
      await startAndNeedModel();
      await waitFor(() => expect(flow.needs).not.toBeNull());
      act(() => {
        useDawStore
          .getState()
          .hydrate("/tmp/other.project.json", minimalProject());
        useDawStore.getState().hydrate(EXPORT_PATH, minimalProject());
        useDawStore.setState({ stage: "deliver" });
      });
      await waitFor(() => expect(flow.needs).toBeNull());
      expect(server.exportRequests).toHaveLength(1);
    });

    it("drops the wait, not into a failure, when the project changes", async () => {
      const { land } = await startAndNeedModel();
      await waitFor(() => expect(flow.needs).not.toBeNull());

      act(() =>
        useDawStore.setState({ projectPath: "/tmp/other.project.json" }),
      );
      await waitFor(() => expect(flow.needs).toBeNull());
      land("rnnoise");
      await act(async () => {});
      expect(flow.run).toEqual({ kind: "idle" });
      expect(flow.request).toBeNull();
      expect(server.exportRequests).toHaveLength(1);
      expect(useDawStore.getState().jobFeedback).toEqual(
        new Map([["x1", { kind: "unverified" }]]),
      );
    });

    it("fails instead of looping when the same model is refused again after it landed", async () => {
      const { land } = await startAndNeedModel();
      await waitFor(() => expect(flow.needs).not.toBeNull());
      server.reopen();
      land("rnnoise");
      await waitFor(() => expect(server.exportRequests).toHaveLength(2));
      await act(async () => server.settle(EXPORT_MODEL_NEEDED));

      await waitFor(() => expect(flow.run.kind).toBe("failed"));
      expect(flow.needs).toBeNull();
      expect(server.exportRequests).toHaveLength(2);
    });

    it("says it plainly instead of waiting when the person left Deliver before the job failed", async () => {
      mountNeeding();
      await loaded();
      act(() => flow.start(["mp3"], REQUEST));
      await running();
      act(() => useDawStore.setState({ stage: "edit" }));
      await act(async () => server.settle(EXPORT_MODEL_NEEDED));

      await waitFor(() => expect(flow.run.kind).toBe("failed"));
      expect(flow.needs).toBeNull();
      expect(flow.run).toEqual({
        kind: "failed",
        reason: expect.stringContaining("Noise reduction (RNNoise)"),
      });
    });
  });
});
