import { describe, expect, it } from "vitest";
import type {
  BootstrapJobSnapshot,
  BootstrapStatus,
  ModelStatus,
} from "../api";
import {
  initialState,
  jobFailures,
  overlay,
  reduce,
  toolsOf,
} from "./controller";
import type { ModelFailure } from "./types";

function row(over: Partial<ModelStatus> & { id: string }): ModelStatus {
  return {
    label: over.id,
    purpose: "purpose",
    tier: "offered",
    model: over.id,
    size: "~1 MB",
    size_bytes: 1_000_000,
    state: "missing",
    ...over,
  };
}

const ROWS: ModelStatus[] = [
  row({ id: "whisper", tier: "required", model: "large-v3-turbo" }),
  row({ id: "rnnoise", tier: "recommended" }),
  row({ id: "word-aligner", model: "onnx-base", state: "update_needed" }),
  row({ id: "speaker-ecapa", state: "installed" }),
];

function status(over: Partial<BootstrapStatus> = {}): BootstrapStatus {
  return {
    ready: false,
    cdn_base: false,
    whisper_model: "large-v3-turbo",
    whisper_models: [],
    tools: { ffmpeg: { state: "installed", source: "bundled", hint: null } },
    models: ROWS,
    ...over,
  };
}

function job(over: Partial<BootstrapJobSnapshot> = {}): BootstrapJobSnapshot {
  return {
    id: "j1",
    kind: "bootstrap",
    components: ["whisper", "rnnoise"],
    whisper_model: "large-v3-turbo",
    status: "running",
    ...over,
  };
}

const kinds = (views: { state: { kind: string } }[]) =>
  views.map((v) => v.state.kind);

describe("overlay", () => {
  it("keeps server order and reads the install state", () => {
    const views = overlay(status(), null, {});
    expect(views.map((v) => v.id)).toEqual([
      "whisper",
      "rnnoise",
      "word-aligner",
      "speaker-ecapa",
    ]);
    expect(kinds(views)).toEqual([
      "missing",
      "missing",
      "update_needed",
      "installed",
    ]);
    expect(views[0]).toMatchObject({
      tier: "required",
      size: "~1 MB",
      sizeBytes: 1_000_000,
      variant: "large-v3-turbo",
    });
    expect(views[1]!.variant).toBeNull();
  });

  it("shows the downloading component with bytes and total and queues the others", () => {
    const views = overlay(
      status(),
      job({ download: { component: "whisper", bytes: 420, total: 1600 } }),
      {},
    );
    expect(views[0]!.state).toEqual({
      kind: "downloading",
      bytes: 420,
      total: 1600,
    });
    expect(views[1]!.state).toEqual({ kind: "queued" });
    expect(views[2]!.state).toEqual({ kind: "update_needed" });
  });

  it("keeps a null total so the bar is indeterminate", () => {
    const views = overlay(
      status(),
      job({ download: { component: "rnnoise", bytes: 5, total: null } }),
      {},
    );
    expect(views[1]!.state).toEqual({
      kind: "downloading",
      bytes: 5,
      total: null,
    });
    expect(views[0]!.state).toEqual({ kind: "queued" });
  });

  it("queues every component of a running job before the first byte", () => {
    const views = overlay(status(), job(), {});
    expect(kinds(views)).toEqual([
      "queued",
      "queued",
      "update_needed",
      "installed",
    ]);
  });

  it("shows a failure on its row and not once the row is installed", () => {
    const failure: ModelFailure = { kind: "http", plain: "Not found." };
    expect(overlay(status(), null, { rnnoise: failure })[1]!.state).toEqual({
      kind: "failed",
      failure,
    });
    const installed = status({
      models: [row({ id: "rnnoise", state: "installed" })],
    });
    expect(overlay(installed, null, { rnnoise: failure })[0]!.state).toEqual({
      kind: "installed",
    });
  });

  it("does not let a failure hide a live download of the same row", () => {
    const failure: ModelFailure = { kind: null, plain: "Old." };
    const views = overlay(
      status(),
      job({ download: { component: "rnnoise", bytes: 1, total: 2 } }),
      { rnnoise: failure },
    );
    expect(views[1]!.state.kind).toBe("downloading");
  });
});

describe("toolsOf", () => {
  it("reads ffmpeg from the tools block", () => {
    expect(
      toolsOf(
        status({
          tools: {
            ffmpeg: { state: "missing", source: "x", hint: "Reinstall." },
          },
        }),
      ),
    ).toEqual({ ffmpeg: "missing", hint: "Reinstall." });
    expect(toolsOf(null)).toEqual({ ffmpeg: "missing", hint: null });
  });
});

describe("jobFailures", () => {
  const typed = {
    kind: "http",
    status: 404,
    plain: "The server has no RNNoise.",
  };

  it("reads a typed failure from the per-component result", () => {
    const failures = jobFailures(
      job({
        status: "error",
        result: {
          results: {
            whisper: { ok: true },
            rnnoise: { ok: false, error: typed.plain, failure: typed },
          },
        },
      }),
      ["whisper", "rnnoise"],
    );
    expect(failures).toEqual({
      rnnoise: { kind: "http", plain: typed.plain },
    });
  });

  it("falls back to the plain error text when no failure is typed", () => {
    const failures = jobFailures(
      job({
        status: "error",
        result: {
          results: {
            whisper: { ok: false, error: "Whisper could not be installed." },
          },
        },
      }),
      ["whisper"],
    );
    expect(failures).toEqual({
      whisper: { kind: null, plain: "Whisper could not be installed." },
    });
  });

  it("charges every still-missing requested row with the job failure when there is no result", () => {
    const failures = jobFailures(
      job({
        status: "error",
        failure: { kind: "network", status: null, plain: "No connection." },
        result: null,
      }),
      ["whisper", "rnnoise"],
    );
    expect(failures).toEqual({
      whisper: { kind: "network", plain: "No connection." },
      rnnoise: { kind: "network", plain: "No connection." },
    });
  });

  it("uses the job error text when there is neither a result nor a typed failure", () => {
    const failures = jobFailures(
      job({ status: "error", error: "The download could not be completed." }),
      ["whisper"],
    );
    expect(failures).toEqual({
      whisper: { kind: null, plain: "The download could not be completed." },
    });
  });

  it("reports nothing for an ok or cancelled job", () => {
    expect(
      jobFailures(job({ status: "ok", result: { results: {} } }), ["a"]),
    ).toEqual({});
    expect(jobFailures(job({ status: "cancelled" }), ["a"])).toEqual({});
  });
});

describe("reduce", () => {
  const failure: ModelFailure = { kind: null, plain: "Broke." };

  it("clears a failure when a new download of that row starts", () => {
    const state = reduce(
      { ...initialState, failures: { whisper: failure, rnnoise: failure } },
      { type: "downloadStarted", ids: ["rnnoise"] },
    );
    expect(state.failures).toEqual({ whisper: failure });
  });

  it("clears a failure when refetched status says installed", () => {
    const state = reduce(
      {
        ...initialState,
        failures: { "speaker-ecapa": failure, whisper: failure },
      },
      {
        type: "statusLoaded",
        status: status({
          models: [
            row({ id: "whisper", state: "installed" }),
            row({ id: "rnnoise" }),
          ],
        }),
      },
    );
    expect(state.failures).toEqual({ "speaker-ecapa": failure });
    expect(state.status?.models).toHaveLength(2);
  });

  it("keeps a live job and drops a terminal one", () => {
    const live = reduce(initialState, { type: "jobSeen", job: job() });
    expect(live.job?.id).toBe("j1");
    const done = reduce(live, {
      type: "jobSeen",
      job: job({ status: "ok" }),
    });
    expect(done.job).toBeNull();
  });

  it("adds terminal failures", () => {
    const state = reduce(initialState, {
      type: "failed",
      failures: { whisper: failure },
    });
    expect(state.failures).toEqual({ whisper: failure });
  });

  it("records a load error and clears it on the next status", () => {
    const errored = reduce(initialState, {
      type: "loadFailed",
      message: "Offline.",
    });
    expect(errored.loadError).toBe("Offline.");
    expect(
      reduce(errored, { type: "statusLoaded", status: status() }).loadError,
    ).toBeNull();
  });

  it("follows the chosen whisper variant, starting from the server's", () => {
    const loaded = reduce(initialState, {
      type: "statusLoaded",
      status: status(),
    });
    expect(loaded.variant).toBe("large-v3-turbo");
    const chosen = reduce(loaded, {
      type: "variantChosen",
      variant: "small.en",
    });
    expect(chosen.variant).toBe("small.en");
    const reloaded = reduce(chosen, {
      type: "statusLoaded",
      status: status({ whisper_model: "small.en" }),
    });
    expect(reloaded.variant).toBe("small.en");
  });
});
