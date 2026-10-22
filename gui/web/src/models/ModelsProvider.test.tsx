import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BootstrapJobSnapshot,
  BootstrapStatus,
  ModelStatus,
} from "../api";
import * as api from "../api";
import { ApiError } from "../utils/apiError";
import { ModelRow } from "./ModelRow";
import { ModelsProvider } from "./ModelsProvider";
import { useModel, useModels } from "./useModels";

vi.mock("../api", () => ({
  fetchBootstrapStatus: vi.fn(),
  fetchBootstrapJob: vi.fn(),
  runBootstrap: vi.fn(),
  waitForBootstrapJob: vi.fn(),
  cancelBootstrap: vi.fn(),
}));

const fetchStatus = vi.mocked(api.fetchBootstrapStatus);
const fetchJob = vi.mocked(api.fetchBootstrapJob);
const run = vi.mocked(api.runBootstrap);
const wait = vi.mocked(api.waitForBootstrapJob);
const cancel = vi.mocked(api.cancelBootstrap);

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

function status(
  models: ModelStatus[],
  over: Partial<BootstrapStatus> = {},
): BootstrapStatus {
  return {
    ready: false,
    cdn_base: false,
    whisper_model: "large-v3-turbo",
    whisper_models: [
      {
        id: "large-v3-turbo",
        label: "Recommended",
        size: "~1.6 GB",
        description: "",
      },
      { id: "small.en", label: "Balanced", size: "~500 MB", description: "" },
    ],
    tools: { ffmpeg: { state: "installed", source: "bundled", hint: null } },
    models,
    ...over,
  };
}

const MISSING = [
  row({ id: "whisper", tier: "required", model: "large-v3-turbo" }),
  row({ id: "rnnoise", tier: "recommended" }),
];

function job(over: Partial<BootstrapJobSnapshot> = {}): BootstrapJobSnapshot {
  return {
    id: "j1",
    kind: "bootstrap",
    components: ["whisper"],
    whisper_model: "large-v3-turbo",
    status: "running",
    ...over,
  };
}

type Waiter = {
  id: string;
  onUpdate: (j: BootstrapJobSnapshot) => void;
  finish: (j: BootstrapJobSnapshot) => void;
  signal?: AbortSignal;
};
let waiters: Waiter[] = [];

function wrapper({ children }: { children: ReactNode }) {
  return <ModelsProvider>{children}</ModelsProvider>;
}

beforeEach(() => {
  vi.resetAllMocks();
  waiters = [];
  fetchStatus.mockResolvedValue(status(MISSING));
  fetchJob.mockResolvedValue(null);
  wait.mockImplementation(
    (id, opts) =>
      new Promise<BootstrapJobSnapshot>((resolve, reject) => {
        const waiter: Waiter = {
          id,
          onUpdate: (j) => opts?.onUpdate?.(j),
          finish: resolve,
          signal: opts?.signal,
        };
        opts?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        waiters.push(waiter);
      }),
  );
});

async function mounted() {
  const hook = renderHook(() => useModels(), { wrapper });
  await waitFor(() => expect(hook.result.current.models).not.toBeNull());
  return hook;
}

describe("ModelsProvider", () => {
  it("loads status and the current job once at mount and posts nothing", async () => {
    const { result } = await mounted();
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(fetchJob).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(result.current.models!.map((m) => m.id)).toEqual([
      "whisper",
      "rnnoise",
    ]);
    expect(result.current.busy).toBe(false);
    expect(result.current.ready).toBe(false);
    expect(result.current.tools).toEqual({ ffmpeg: "installed", hint: null });
    expect(result.current.whisper.variant).toBe("large-v3-turbo");
    expect(result.current.whisper.variants).toHaveLength(2);
  });

  it("reports a load error and no models", async () => {
    fetchStatus.mockRejectedValue(new Error("Offline."));
    const { result } = renderHook(() => useModels(), { wrapper });
    await waitFor(() => expect(result.current.loadError).toBe("Offline."));
    expect(result.current.models).toBeNull();
  });

  it("adopts a live job at mount and shows its bar", async () => {
    fetchJob.mockResolvedValue(
      job({ download: { component: "whisper", bytes: 420, total: 1600 } }),
    );
    const { result } = await mounted();
    await waitFor(() => expect(result.current.busy).toBe(true));
    expect(wait).toHaveBeenCalledWith("j1", expect.anything());
    expect(result.current.models![0]!.state).toEqual({
      kind: "downloading",
      bytes: 420,
      total: 1600,
    });
    expect(result.current.models![1]!.state).toEqual({ kind: "missing" });
  });

  it("ignores a finished job found at mount", async () => {
    fetchJob.mockResolvedValue(job({ status: "ok" }));
    const { result } = await mounted();
    expect(result.current.busy).toBe(false);
    expect(wait).not.toHaveBeenCalled();
  });

  it("fetches status again only when the job ends, never on progress frames", async () => {
    run.mockResolvedValue({ job: job() });
    const { result } = await mounted();
    let outcome: Promise<unknown> = Promise.resolve();
    act(() => {
      outcome = result.current.download(["whisper"]);
    });
    await waitFor(() => expect(waiters).toHaveLength(1));
    act(() => {
      waiters[0]!.onUpdate(
        job({ download: { component: "whisper", bytes: 1, total: 10 } }),
      );
      waiters[0]!.onUpdate(
        job({ download: { component: "whisper", bytes: 5, total: 10 } }),
      );
    });
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(result.current.models![0]!.state).toMatchObject({
      kind: "downloading",
      bytes: 5,
    });
    fetchStatus.mockResolvedValue(
      status([row({ id: "whisper", state: "installed" }), MISSING[1]!]),
    );
    await act(async () => {
      waiters[0]!.finish(job({ status: "ok" }));
      await outcome;
    });
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await expect(outcome).resolves.toEqual({ kind: "ok" });
    expect(result.current.models![0]!.state).toEqual({ kind: "installed" });
    expect(result.current.busy).toBe(false);
  });

  it("posts the chosen ids with the variant and no force", async () => {
    run.mockResolvedValue({ job: job({ components: ["whisper", "rnnoise"] }) });
    const { result } = await mounted();
    act(() => {
      void result.current.download(["whisper", "rnnoise"], {
        whisperModel: "small.en",
      });
    });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenCalledWith({
      components: ["whisper", "rnnoise"],
      whisper_model: "small.en",
      force: false,
    });
  });

  it("sends force when any requested row needs an update", async () => {
    fetchStatus.mockResolvedValue(
      status([
        row({ id: "word-aligner", state: "update_needed" }),
        row({ id: "rnnoise" }),
      ]),
    );
    run.mockResolvedValue({ job: job({ components: ["word-aligner"] }) });
    const { result } = await mounted();
    act(() => {
      void result.current.download(["word-aligner"]);
    });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0]![0]).toMatchObject({
      components: ["word-aligner"],
      force: true,
    });
    expect(run.mock.calls[0]![0]).not.toHaveProperty("whisper_model");
  });

  it("on a 409 adopts the running job, returns busy and posts once", async () => {
    run.mockRejectedValue(
      new ApiError("running", "bootstrap_job_running", 409),
    );
    fetchJob
      .mockResolvedValueOnce(null)
      .mockResolvedValue(job({ components: ["rnnoise"] }));
    const { result } = await mounted();
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.download(["whisper"]);
    });
    expect(outcome).toEqual({ kind: "busy" });
    expect(run).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.busy).toBe(true));
    expect(wait).toHaveBeenCalledWith("j1", expect.anything());
    expect(result.current.models![1]!.state).toEqual({ kind: "queued" });
    await act(async () => {
      outcome = await result.current.download(["whisper"]);
    });
    expect(outcome).toEqual({ kind: "busy" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("attaches to the joined job when the server says adopted", async () => {
    run.mockResolvedValue({ job: job(), adopted: true });
    const { result } = await mounted();
    act(() => {
      void result.current.download(["whisper"]);
    });
    await waitFor(() => expect(waiters).toHaveLength(1));
    expect(waiters[0]!.id).toBe("j1");
    expect(result.current.busy).toBe(true);
  });

  it("puts a typed failure on its row and keeps the other row", async () => {
    run.mockResolvedValue({ job: job({ components: ["whisper", "rnnoise"] }) });
    const { result } = await mounted();
    let outcome: Promise<unknown> = Promise.resolve();
    act(() => {
      outcome = result.current.download(["whisper", "rnnoise"]);
    });
    await waitFor(() => expect(waiters).toHaveLength(1));
    await act(async () => {
      waiters[0]!.finish(
        job({
          components: ["whisper", "rnnoise"],
          status: "error",
          error: "The download server doesn't have RNNoise.",
          failure: {
            kind: "http",
            status: 404,
            plain: "The download server doesn't have RNNoise.",
          },
          result: {
            results: {
              whisper: { ok: true },
              rnnoise: {
                ok: false,
                error: "The download server doesn't have RNNoise.",
                failure: {
                  kind: "http",
                  status: 404,
                  plain: "The download server doesn't have RNNoise.",
                },
              },
            },
          },
        }),
      );
      await outcome;
    });
    await expect(outcome).resolves.toEqual({
      kind: "failed",
      failed: ["rnnoise"],
    });
    expect(result.current.models![1]!.state).toEqual({
      kind: "failed",
      failure: {
        kind: "http",
        plain: "The download server doesn't have RNNoise.",
      },
    });
    run.mockResolvedValue({ job: job({ components: ["rnnoise"] }) });
    act(() => {
      void result.current.download(["rnnoise"]);
    });
    await waitFor(() =>
      expect(result.current.models![1]!.state.kind).toBe("queued"),
    );
  });

  it("reports a cancelled job as cancelled and posts the cancel", async () => {
    run.mockResolvedValue({ job: job() });
    cancel.mockResolvedValue(job());
    const { result } = await mounted();
    let outcome: Promise<unknown> = Promise.resolve();
    act(() => {
      outcome = result.current.download(["whisper"]);
    });
    await waitFor(() => expect(waiters).toHaveLength(1));
    await act(async () => {
      await result.current.cancel();
    });
    expect(cancel).toHaveBeenCalledWith("j1");
    await act(async () => {
      waiters[0]!.finish(job({ status: "cancelled" }));
      await outcome;
    });
    await expect(outcome).resolves.toEqual({ kind: "cancelled" });
    expect(result.current.busy).toBe(false);
  });

  it("turns a failed start request into a failed row", async () => {
    run.mockRejectedValue(new Error("Failed to fetch"));
    const { result } = await mounted();
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.download(["rnnoise"]);
    });
    expect(outcome).toEqual({ kind: "failed", failed: ["rnnoise"] });
    expect(result.current.models![1]!.state).toMatchObject({ kind: "failed" });
    expect(result.current.busy).toBe(false);
  });

  it("shows no environment name or absolute path in a failed row's alert", async () => {
    run.mockRejectedValue(
      new Error(
        "Could not reach PODCAST_BOOTSTRAP_CDN_BASE while writing /home/x/.cache/podcast/models/a.bin and C:\\Users\\x\\models\\a.bin",
      ),
    );
    const { result } = await mounted();
    await act(async () => {
      await result.current.download(["rnnoise"]);
    });
    render(
      <ModelRow model={result.current.models![1]!} action={{ kind: "none" }} />,
    );
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).not.toBe("");
    expect(alert).not.toMatch(/PODCAST_/);
    expect(alert).not.toMatch(/\/home\/|C:\\/);
  });

  it("does not reject when cancel fails, and reads status again", async () => {
    run.mockResolvedValue({ job: job() });
    cancel.mockRejectedValue(new Error("Failed to fetch"));
    const { result } = await mounted();
    act(() => {
      void result.current.download(["whisper"]);
    });
    await waitFor(() => expect(waiters).toHaveLength(1));
    fetchStatus.mockClear();
    await act(async () => {
      await expect(result.current.cancel()).resolves.toBeUndefined();
    });
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it("drops a Whisper failure when another size is chosen", async () => {
    run.mockResolvedValue({ job: job() });
    const { result } = await mounted();
    let outcome: Promise<unknown> = Promise.resolve();
    act(() => {
      outcome = result.current.download(["whisper"]);
    });
    await waitFor(() => expect(waiters).toHaveLength(1));
    await act(async () => {
      waiters[0]!.finish(
        job({
          status: "error",
          result: { results: { whisper: { ok: false, error: "No space." } } },
        }),
      );
      await outcome;
    });
    expect(result.current.models![0]!.state.kind).toBe("failed");
    act(() => result.current.whisper.choose("small.en"));
    expect(result.current.models![0]!.state.kind).toBe("missing");
  });

  it("refetches status for a chosen variant and drops a stale response", async () => {
    const { result } = await mounted();
    let releaseFirst: (s: BootstrapStatus) => void = () => {};
    fetchStatus.mockImplementationOnce(
      () =>
        new Promise<BootstrapStatus>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    fetchStatus.mockResolvedValueOnce(
      status(
        [
          row({ id: "whisper", state: "installed", model: "base.en" }),
          MISSING[1]!,
        ],
        { whisper_model: "base.en" },
      ),
    );
    act(() => result.current.whisper.choose("small.en"));
    act(() => result.current.whisper.choose("base.en"));
    expect(result.current.whisper.variant).toBe("base.en");
    expect(fetchStatus).toHaveBeenLastCalledWith("base.en");
    await waitFor(() =>
      expect(result.current.models![0]!.state).toEqual({ kind: "installed" }),
    );
    await act(async () => {
      releaseFirst(
        status([row({ id: "whisper", model: "small.en" }), MISSING[1]!], {
          whisper_model: "small.en",
        }),
      );
    });
    expect(result.current.whisper.variant).toBe("base.en");
    expect(result.current.models![0]!.state).toEqual({ kind: "installed" });
  });

  it("aborts the wait on unmount", async () => {
    fetchJob.mockResolvedValue(job());
    const hook = await mounted();
    await waitFor(() => expect(waiters).toHaveLength(1));
    hook.unmount();
    expect(waiters[0]!.signal!.aborted).toBe(true);
  });
});

describe("useModel", () => {
  it("returns one row and download bound to its id", async () => {
    run.mockResolvedValue({ job: job({ components: ["rnnoise"] }) });
    const hook = renderHook(() => useModel("rnnoise"), { wrapper });
    await waitFor(() => expect(hook.result.current.row).not.toBeNull());
    expect(hook.result.current.row!.id).toBe("rnnoise");
    act(() => {
      void hook.result.current.download();
    });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0]![0]).toMatchObject({ components: ["rnnoise"] });
    await waitFor(() => expect(hook.result.current.busy).toBe(true));
  });

  it("is null for an id the server does not list", async () => {
    const hook = renderHook(() => useModel("nope"), { wrapper });
    await waitFor(() => expect(fetchStatus).toHaveBeenCalled());
    await act(async () => {});
    expect(hook.result.current.row).toBeNull();
  });
});

describe("useModels outside a provider", () => {
  it("is inert: no rows, not busy, downloads do nothing", async () => {
    const { result } = renderHook(() => useModels());
    expect(result.current.models).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(await result.current.download(["whisper"])).toEqual({
      kind: "cancelled",
    });
    expect(run).not.toHaveBeenCalled();
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it("gives useModel a null row and a no-op download", async () => {
    const { result } = renderHook(() => useModel("speaker-ecapa"));
    expect(result.current.row).toBeNull();
    expect(await result.current.download()).toEqual({ kind: "cancelled" });
  });
});

describe("a reload keeps the person's Whisper size pick", () => {
  it("does not reset the picker when a load answers with the server's size", async () => {
    const { result } = await mounted();
    fetchStatus.mockResolvedValueOnce(status(MISSING));
    act(() => result.current.whisper.choose("small.en"));
    await waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(result.current.whisper.variant).toBe("small.en");
  });
});

describe("every status read is for the picked Whisper size", () => {
  const byVariant = (variant?: string) => {
    const picked = variant ?? "large-v3-turbo";
    return Promise.resolve(
      status(
        [
          row({
            id: "whisper",
            tier: "required",
            model: picked,
            state: picked === "large-v3-turbo" ? "installed" : "missing",
          }),
          MISSING[1]!,
        ],
        { whisper_model: picked },
      ),
    );
  };

  it("keeps the picked size not installed when a non-Whisper job ends", async () => {
    fetchStatus.mockImplementation(byVariant);
    run.mockResolvedValue({
      job: job({ id: "j2", components: ["rnnoise"] }),
    });
    const { result } = await mounted();
    act(() => result.current.whisper.choose("small.en"));
    await waitFor(() =>
      expect(result.current.models![0]!.state.kind).toBe("missing"),
    );
    let outcome: Promise<unknown> = Promise.resolve();
    act(() => {
      outcome = result.current.download(["rnnoise"]);
    });
    await waitFor(() => expect(waiters).toHaveLength(1));
    await act(async () => {
      waiters[0]!.finish(
        job({ id: "j2", components: ["rnnoise"], status: "ok" }),
      );
      await outcome;
    });
    expect(fetchStatus).toHaveBeenLastCalledWith("small.en");
    expect(result.current.whisper.variant).toBe("small.en");
    expect(result.current.models![0]!.state.kind).toBe("missing");
  });

  it("keeps the picked size's state when another tab's job of a different size ends", async () => {
    fetchStatus.mockImplementation(byVariant);
    fetchJob.mockResolvedValue(job({ id: "other" }));
    const { result } = await mounted();
    await waitFor(() => expect(waiters).toHaveLength(1));
    act(() => result.current.whisper.choose("small.en"));
    await waitFor(() =>
      expect(result.current.models![0]!.state.kind).toBe("queued"),
    );
    await act(async () => {
      waiters[0]!.finish(job({ id: "other", status: "ok" }));
    });
    await waitFor(() =>
      expect(result.current.models![0]!.state.kind).toBe("missing"),
    );
    expect(fetchStatus).toHaveBeenLastCalledWith("small.en");
    expect(result.current.whisper.variant).toBe("small.en");
  });
});
