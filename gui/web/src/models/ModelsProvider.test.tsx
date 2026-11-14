import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useLayoutEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BootstrapJobSnapshot,
  BootstrapStatus,
  ModelStatus,
} from "../api";
import * as api from "../api";
import { setupOf } from "../stages/home/homeModel";
import { deferred } from "../test/deferred";
import { DESKTOP_HOST } from "../test/renderWithModels";
import { stubViewportShell } from "../test/viewportShell";
import { ApiError } from "../utils/apiError";
import type { NeedTarget } from "./capability";
import { ModelNeedRow, ModelNeedRowView } from "./ModelNeedRow";
import { ModelsProvider } from "./ModelsProvider";
import { ModelsSheet } from "./ModelsSheet";
import { useModelResume } from "./useModelResume";
import { useModels } from "./useModels";

vi.mock("../api", () => ({
  fetchBootstrapStatus: vi.fn(),
  fetchBootstrapJob: vi.fn(),
  runBootstrap: vi.fn(),
  waitForBootstrapJob: vi.fn(),
  cancelBootstrap: vi.fn(),
  removeBootstrapModel: vi.fn(),
}));

const fetchStatus = vi.mocked(api.fetchBootstrapStatus);
const fetchJob = vi.mocked(api.fetchBootstrapJob);
const run = vi.mocked(api.runBootstrap);
const wait = vi.mocked(api.waitForBootstrapJob);
const cancel = vi.mocked(api.cancelBootstrap);
const removeModel = vi.mocked(api.removeBootstrapModel);

function row(over: Partial<ModelStatus> & { id: string }): ModelStatus {
  return {
    label: over.id,
    purpose: "purpose",
    tier: "recommended",
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
    host: DESKTOP_HOST,
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
    failed_components: [],
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
  it("keeps Home status retry available when a read fails after an installed snapshot", async () => {
    fetchStatus.mockResolvedValue(
      status(
        MISSING.map((m) => ({ ...m, state: "installed" })),
        { ready: true },
      ),
    );
    const { result } = await mounted();
    expect(setupOf(result.current)).toBeNull();
    fetchStatus.mockRejectedValueOnce(new Error("Status offline"));
    await act(() => result.current.refresh());
    expect(setupOf(result.current)?.state).toBe("check-error");
  });
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

  it("refresh reads status again without posting a download", async () => {
    const { result } = await mounted();
    fetchStatus.mockResolvedValue(
      status([
        row({ id: "whisper", tier: "required", state: "installed" }),
        row({ id: "rnnoise", tier: "recommended" }),
      ]),
    );
    await act(() => result.current.refresh());
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(result.current.models![0].state.kind).toBe("installed");
    expect(run).not.toHaveBeenCalled();
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

  it.each([1, 3])(
    "retains %i cancellation request(s) made before download admission",
    async (clicks) => {
      const pending = deferred<Awaited<ReturnType<typeof api.runBootstrap>>>();
      run.mockReturnValueOnce(pending.promise);
      cancel.mockResolvedValue(job({ id: "requested" }));
      const { result } = await mounted();
      let outcome: Promise<unknown> = Promise.resolve();
      act(() => {
        outcome = result.current.download(["whisper"]);
      });
      await act(async () => {
        for (let index = 0; index < clicks; index++)
          await result.current.cancel();
      });
      expect(cancel).not.toHaveBeenCalled();
      await act(async () => pending.resolve({ job: job({ id: "requested" }) }));
      await waitFor(() => expect(waiters).toHaveLength(1));
      try {
        await waitFor(() =>
          expect(cancel).toHaveBeenCalledExactlyOnceWith("requested"),
        );
      } finally {
        await act(async () => {
          waiters[0]!.finish(job({ id: "requested", status: "cancelled" }));
          await outcome;
        });
      }
      await expect(outcome).resolves.toEqual({ kind: "cancelled" });
      expect(result.current.busy).toBe(false);
    },
  );

  it("reports the terminal job without waiting for a late cancellation response", async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.runBootstrap>>>();
    const cancellation = deferred<BootstrapJobSnapshot>();
    run.mockReturnValueOnce(pending.promise);
    cancel.mockReturnValueOnce(cancellation.promise);
    const { result } = await mounted();
    let outcome: Promise<unknown> = Promise.resolve();
    const finished = vi.fn();
    act(() => {
      outcome = result.current.download(["whisper"]);
      void outcome.then(finished);
    });
    await act(async () => result.current.cancel());
    await act(async () => pending.resolve({ job: job() }));
    await waitFor(() => expect(cancel).toHaveBeenCalledExactlyOnceWith("j1"));
    await act(async () => {
      waiters[0]!.finish(job({ status: "cancelled" }));
    });
    try {
      await waitFor(() =>
        expect(finished).toHaveBeenCalledExactlyOnceWith({ kind: "cancelled" }),
      );
      expect(result.current.busy).toBe(false);
    } finally {
      await act(async () => {
        cancellation.resolve(job({ status: "cancelled" }));
        await outcome;
      });
    }
  });

  it("retires pending cancellation after a start failure before the next download", async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.runBootstrap>>>();
    run.mockReturnValueOnce(pending.promise);
    const { result } = await mounted();
    let failed: Promise<unknown> = Promise.resolve();
    act(() => {
      failed = result.current.download(["whisper"]);
    });
    await act(async () => result.current.cancel());
    await act(async () => {
      pending.reject(new Error("Start failed"));
      await failed;
    });
    await expect(failed).resolves.toEqual({
      kind: "failed",
      failed: ["whisper"],
    });
    run.mockResolvedValueOnce({ job: job({ id: "next" }) });
    let next: Promise<unknown> = Promise.resolve();
    act(() => {
      next = result.current.download(["whisper"]);
    });
    await waitFor(() => expect(waiters).toHaveLength(1));
    expect(cancel).not.toHaveBeenCalled();
    fetchStatus.mockResolvedValue(
      status(MISSING.map((model) => ({ ...model, state: "installed" }))),
    );
    await act(async () => {
      waiters[0]!.finish(job({ id: "next", status: "ok" }));
      await next;
    });
    await expect(next).resolves.toEqual({ kind: "ok" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("does not apply a refused start's pending cancellation to an unrelated adopted download", async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.runBootstrap>>>();
    run.mockReturnValueOnce(pending.promise);
    const { result } = await mounted();
    let outcome: Promise<unknown> = Promise.resolve();
    act(() => {
      outcome = result.current.download(["whisper"]);
    });
    await act(async () => result.current.cancel());
    fetchJob.mockResolvedValue(job({ id: "other", components: ["rnnoise"] }));
    await act(async () => {
      pending.reject(
        new ApiError(
          "Another download is running",
          "bootstrap_job_running",
          409,
        ),
      );
      await outcome;
    });
    await expect(outcome).resolves.toEqual({ kind: "busy" });
    await waitFor(() => expect(waiters).toHaveLength(1));
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => {
      waiters[0]!.finish(
        job({ id: "other", components: ["rnnoise"], status: "ok" }),
      );
    });
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(cancel).not.toHaveBeenCalled();
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

  it("shows no environment name or absolute path in a failed row's text", async () => {
    run.mockRejectedValue(
      new Error(
        "Could not reach PODCAST_BOOTSTRAP_CDN_BASE while writing /home/x/.cache/podcast/models/a.bin and C:\\Users\\x\\models\\a.bin",
      ),
    );
    const { result } = await mounted();
    await act(async () => {
      await result.current.download(["rnnoise"]);
    });
    const failed = result.current.models![1]!;
    render(
      <ModelNeedRowView
        placement="list"
        model={failed}
        state={failed.state}
        onGet={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const alert = document.querySelector(".sys-need-meta")?.textContent ?? "";
    expect(alert).not.toBe("");
    expect(alert).not.toMatch(/PODCAST_/);
    expect(alert).not.toMatch(/\/home\/|C:\\/);
  });

  it("is busy from Get until the server answers, so the Size control cannot change under the start", async () => {
    let answer: (value: { job: ReturnType<typeof job> }) => void = () =>
      undefined;
    run.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { result } = await mounted();
    expect(result.current.busy).toBe(false);
    act(() => {
      void result.current.download(["whisper"]);
    });
    expect(result.current.busy).toBe(true);
    const states = Object.fromEntries(
      (result.current.models ?? []).map((m) => [m.id, m.state.kind]),
    );
    expect(states).toMatchObject({ whisper: "queued", rnnoise: "missing" });
    await act(async () => answer({ job: job() }));
    await waitFor(() => expect(waiters).toHaveLength(1));
    expect(result.current.busy).toBe(true);
    await act(async () => {
      waiters[0]!.finish(job({ status: "ok" }));
    });
    await waitFor(() => expect(result.current.busy).toBe(false));
  });

  it("is not busy after a start that failed", async () => {
    run.mockRejectedValue(new Error("down"));
    const { result } = await mounted();
    await act(async () => {
      await result.current.download(["whisper"]);
    });
    expect(result.current.busy).toBe(false);
  });

  it("removes a model, names the Whisper size, and reads status again", async () => {
    removeModel.mockResolvedValue({ freed_bytes: 1, model: MISSING[0]! });
    const { result } = await mounted();
    fetchStatus.mockClear();
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.remove("whisper", "small.en");
    });
    expect(outcome).toEqual({ kind: "ok" });
    expect(removeModel).toHaveBeenCalledWith("whisper", "small.en");
    expect(fetchStatus.mock.calls).toEqual([["small.en"], [undefined]]);
    await act(async () => {
      await result.current.remove("rnnoise", "ignored");
    });
    expect(removeModel).toHaveBeenLastCalledWith("rnnoise", null);
  });

  it("reports a busy server and a failed removal without reading status", async () => {
    const { result } = await mounted();
    fetchStatus.mockClear();
    removeModel.mockRejectedValueOnce(
      new ApiError("running", "bootstrap_job_running", 409),
    );
    let busy: unknown;
    await act(async () => {
      busy = await result.current.remove("rnnoise");
    });
    expect(busy).toEqual({ kind: "busy" });
    removeModel.mockRejectedValueOnce(
      new ApiError("Studio leaves it alone.", "model_not_removable", 409),
    );
    let failed: unknown;
    await act(async () => {
      failed = await result.current.remove("rnnoise");
    });
    expect(failed).toMatchObject({ kind: "failed" });
    expect(fetchStatus).not.toHaveBeenCalled();
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
    fetchStatus.mockResolvedValue(
      status(
        [
          row({ id: "whisper", model: "small.en", tier: "required" }),
          MISSING[1]!,
        ],
        { whisper_model: "small.en" },
      ),
    );
    act(() => result.current.whisper.choose("small.en"));
    expect(result.current.models![0]!.state.kind).toBe("checking");
    await waitFor(() =>
      expect(result.current.models![0]!.state.kind).toBe("missing"),
    );
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

describe("useModels outside a provider", () => {
  it("is inert: no rows, not busy, downloads do nothing", async () => {
    const { result } = renderHook(() => useModels());
    expect(result.current.models).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(await result.current.download(["whisper"])).toEqual({
      kind: "cancelled",
    });
    await result.current.refresh();
    expect(run).not.toHaveBeenCalled();
    expect(fetchStatus).not.toHaveBeenCalled();
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
    const found = deferred<BootstrapJobSnapshot | null>();
    fetchJob.mockReturnValue(found.promise);
    const { result } = await mounted();
    act(() => result.current.whisper.choose("small.en"));
    await waitFor(() =>
      expect(result.current.models![0]!.state.kind).toBe("missing"),
    );
    await act(async () => found.resolve(job({ id: "other" })));
    await waitFor(() => expect(waiters).toHaveLength(1));
    expect(result.current.models![0]!.state.kind).toBe("missing");
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

describe("an adopted Whisper job", () => {
  it.each(["queued", "downloading"] as const)(
    "does not attribute a Fast %s job to a Best sheet row or inline need",
    async (phase) => {
      const fast = job({
        id: "other",
        whisper_model: "tiny.en",
        ...(phase === "downloading"
          ? { download: { component: "whisper", bytes: 5, total: 10 } }
          : {}),
      });
      fetchJob.mockResolvedValue(fast);
      stubViewportShell("desktop");
      const best = {
        id: "whisper",
        variant: "large-v3-turbo",
        label: "Whisper",
        size: "1.6 GB",
      };
      const observed: Array<ReturnType<typeof useModels>> = [];
      function Observer() {
        observed.push(useModels());
        return null;
      }
      render(
        <ModelsProvider>
          <Observer />
          <ModelsSheet open onClose={vi.fn()} />
          <ModelNeedRow model={best} />
        </ModelsProvider>,
      );
      await waitFor(() => expect(waiters).toHaveLength(1));
      await waitFor(() =>
        expect(observed.at(-1)?.models?.[0]?.state).toEqual({
          kind: "missing",
        }),
      );
      expect(observed.at(-1)?.whisper.variant).toBe("large-v3-turbo");
      expect(observed.at(-1)?.ready).toBe(false);
      expect(observed.at(-1)?.busy).toBe(true);
      const fastRow = screen.getByRole("group", { name: "Transcription Fast" });
      expect(
        within(fastRow).getByRole("button", {
          name: "Cancel Transcription download",
        }),
      ).toBeEnabled();
      const bestRow = screen
        .getByRole("button", { name: "Get Transcription" })
        .closest("li");
      expect(bestRow).not.toBeNull();
      expect(bestRow?.querySelector(".sys-need-cancel")).toBeNull();
      if (phase === "downloading") {
        expect(within(fastRow).getByRole("progressbar")).toHaveAttribute(
          "aria-valuenow",
          "50",
        );
      }
      expect(
        screen.getByRole("button", { name: "Get Transcription" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", {
          name: "Get the transcription model",
          hidden: true,
        }),
      ).toBeDisabled();
      await act(async () => waiters[0]!.finish({ ...fast, status: "ok" }));
      await waitFor(() => expect(observed.at(-1)?.busy).toBe(false));
      expect(fetchStatus).toHaveBeenLastCalledWith(undefined);
      expect(observed.at(-1)?.models?.[0]?.state).toEqual({ kind: "missing" });
    },
  );

  it("lets the actual Fast row cancel the adopted job", async () => {
    fetchStatus.mockResolvedValue(
      status(
        [
          row({ id: "whisper", tier: "required", model: "tiny.en" }),
          MISSING[1]!,
        ],
        { whisper_model: "tiny.en" },
      ),
    );
    fetchJob.mockResolvedValue(job({ id: "other", whisper_model: "tiny.en" }));
    cancel.mockResolvedValue(job({ id: "other", whisper_model: "tiny.en" }));
    stubViewportShell("desktop");
    render(
      <ModelsProvider>
        <ModelsSheet open onClose={vi.fn()} />
      </ModelsProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Cancel Transcription download",
      }),
    );
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("other"));
  });
});

describe("variant ownership regressions", () => {
  it.each(["missing", "installed", "update_needed"] as const)(
    "keeps Best %s while Fast progresses and cancels its exact job",
    async (state) => {
      fetchStatus.mockResolvedValue(
        status([row({ id: "whisper", model: "large-v3-turbo", state })]),
      );
      const fast = job({ id: "fast-owned", whisper_model: "tiny.en" });
      fetchJob.mockResolvedValue(fast);
      cancel.mockResolvedValue(fast);
      stubViewportShell("desktop");
      let current: ReturnType<typeof useModels> | undefined;
      function Observe() {
        current = useModels();
        return null;
      }
      render(
        <ModelsProvider>
          <Observe />
          <ModelsSheet open onClose={vi.fn()} />
        </ModelsProvider>,
      );
      await waitFor(() => expect(waiters).toHaveLength(1));
      act(() =>
        waiters[0]!.onUpdate({
          ...fast,
          download: {
            component: "whisper",
            bytes: 25_000_000,
            total: 75_000_000,
          },
        }),
      );
      await waitFor(() =>
        expect(current?.models?.[0]?.state).toEqual({ kind: state }),
      );
      expect(current?.whisper.variant).toBe("large-v3-turbo");
      const active = screen.getByRole("group", { name: "Transcription Fast" });
      expect(
        within(screen.getByRole("list")).getAllByRole("listitem"),
      ).toHaveLength(1);
      expect(within(active).getByRole("progressbar")).toHaveAttribute(
        "aria-valuetext",
        "25 MB of 75 MB",
      );
      fireEvent.click(
        within(active).getByRole("button", {
          name: "Cancel Transcription download",
        }),
      );
      await waitFor(() =>
        expect(cancel).toHaveBeenCalledExactlyOnceWith("fast-owned"),
      );
      await act(async () =>
        waiters[0]!.finish({ ...fast, status: "cancelled" }),
      );
      await waitFor(() => expect(current?.busy).toBe(false));
      expect(current?.models?.[0]?.state).toEqual({ kind: state });
      expect(current?.whisper.variant).toBe("large-v3-turbo");
      expect(
        screen.queryByRole("group", { name: "Transcription Fast" }),
      ).toBeNull();
    },
  );

  it.each([true, false])(
    "keeps a Fast terminal failure and retry off Best, results=%s",
    async (withResults) => {
      const fast = job({ id: "fast-error", whisper_model: "tiny.en" });
      fetchJob.mockResolvedValue(fast);
      stubViewportShell("desktop");
      let current: ReturnType<typeof useModels> | undefined;
      function Observe() {
        current = useModels();
        return null;
      }
      render(
        <ModelsProvider>
          <Observe />
          <ModelsSheet open onClose={vi.fn()} />
        </ModelsProvider>,
      );
      await waitFor(() => expect(waiters).toHaveLength(1));
      await act(async () =>
        waiters[0]!.finish({
          ...fast,
          status: "error",
          error: "Fast failed.",
          failure: { kind: "network", status: null, plain: "Fast failed." },
          result: withResults
            ? {
                results: {
                  whisper: {
                    ok: false,
                    failure: { kind: "network", plain: "Fast failed." },
                  },
                },
              }
            : null,
        }),
      );
      await waitFor(() => expect(current?.busy).toBe(false));
      expect(current?.models?.[0]?.state).toEqual({ kind: "missing" });
      expect(current?.whisper.variant).toBe("large-v3-turbo");
      const failed = screen.getByRole("group", { name: "Transcription Fast" });
      expect(within(failed).getByText("Fast failed.")).toBeVisible();
      run.mockResolvedValue({ job: { ...fast, id: "retry-fast" } });
      fireEvent.click(
        within(failed).getByRole("button", { name: "Try again Transcription" }),
      );
      await waitFor(() =>
        expect(run).toHaveBeenCalledExactlyOnceWith({
          components: ["whisper"],
          whisper_model: "tiny.en",
          force: false,
        }),
      );
    },
  );

  it.each([true, false])(
    "retains Fast failure when terminal status is superseded, results=%s",
    async (withResults) => {
      const fast = job({ whisper_model: "tiny.en" });
      fetchJob.mockResolvedValue(fast);
      const { result } = await mounted();
      await waitFor(() => expect(waiters).toHaveLength(1));
      await act(async () => {});
      const readsBeforeTerminal = fetchStatus.mock.calls.length;
      const stale = deferred<BootstrapStatus>();
      fetchStatus.mockReturnValueOnce(stale.promise);
      await act(async () =>
        waiters[0]!.finish({
          ...fast,
          status: "error",
          error: "Fast failed.",
          result: withResults
            ? { results: { whisper: { ok: false, error: "Fast failed." } } }
            : null,
        }),
      );
      await waitFor(() =>
        expect(fetchStatus).toHaveBeenCalledTimes(readsBeforeTerminal + 1),
      );
      await act(() => result.current.refresh());
      await act(async () =>
        stale.resolve(
          status(
            [row({ id: "whisper", model: "tiny.en", state: "installed" })],
            { whisper_model: "tiny.en" },
          ),
        ),
      );
      await waitFor(() => expect(result.current.busy).toBe(false));
      expect(result.current.models?.[0]?.state).toEqual({ kind: "missing" });
      expect(result.current.downloads).toEqual([
        expect.objectContaining({
          id: "whisper",
          variant: "tiny.en",
          state: {
            kind: "failed",
            failure: { kind: null, plain: "Fast failed." },
          },
        }),
      ]);
    },
  );

  it.each(["small.en", "large-v3-turbo"])(
    "scopes force to the requested %s observation",
    async (variant) => {
      fetchStatus.mockResolvedValueOnce(
        status([
          row({
            id: "whisper",
            model: "large-v3-turbo",
            state: "update_needed",
          }),
        ]),
      );
      const next = deferred<BootstrapStatus>();
      fetchStatus.mockReturnValue(next.promise);
      run.mockResolvedValue({ job: job({ whisper_model: variant }) });
      const { result } = await mounted();
      act(() => {
        void result.current.download(["whisper"], { whisperModel: variant });
      });
      await waitFor(() =>
        expect(run).toHaveBeenCalledExactlyOnceWith({
          components: ["whisper"],
          whisper_model: variant,
          force: variant === "large-v3-turbo",
        }),
      );
      await act(async () =>
        next.resolve(
          status([row({ id: "whisper", model: variant, state: "installed" })], {
            whisper_model: variant,
          }),
        ),
      );
    },
  );
});

describe("exception ownership", () => {
  it("keeps a failed Fast start attributed to Fast after selection changes", async () => {
    const start = deferred<Awaited<ReturnType<typeof api.runBootstrap>>>();
    run.mockReturnValue(start.promise);
    const { result } = await mounted();
    let outcome: Promise<unknown> = Promise.resolve();
    act(() => {
      outcome = result.current.download(["whisper"], {
        whisperModel: "tiny.en",
      });
    });
    await act(async () => result.current.whisper.choose("large-v3-turbo"));
    await act(async () => {
      start.reject(new Error("Start failed."));
      await outcome;
    });
    expect(result.current.models?.[0]?.state).toEqual({ kind: "missing" });
    expect(result.current.downloads).toEqual([
      expect.objectContaining({
        variant: "tiny.en",
        state: {
          kind: "failed",
          failure: { kind: null, plain: "Start failed." },
        },
      }),
    ]);
    await expect(outcome).resolves.toEqual({
      kind: "failed",
      failed: ["whisper"],
    });
  });

  it("keeps connection loss attributed to the adopted Fast job", async () => {
    const connection = deferred<BootstrapJobSnapshot>();
    fetchJob.mockResolvedValue(
      job({ id: "lost-fast", whisper_model: "tiny.en" }),
    );
    wait.mockReturnValue(connection.promise);
    const { result } = await mounted();
    await waitFor(() => expect(result.current.busy).toBe(true));
    await act(async () => connection.reject(new Error("Connection lost.")));
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.models?.[0]?.state).toEqual({ kind: "missing" });
    expect(result.current.downloads).toEqual([
      expect.objectContaining({
        variant: "tiny.en",
        state: {
          kind: "failed",
          failure: {
            kind: null,
            plain: "Lost the connection to the download. Retry it in a moment.",
          },
        },
      }),
    ]);
  });
});

describe("explicit target observations", () => {
  const fastNeed = {
    id: "whisper",
    variant: "tiny.en",
    label: "Whisper",
    size: "75 MB",
    request: { operation: "original", revision: 7 },
  };
  function variantStatus(variant: string, installed = false) {
    return status(
      [
        row({
          id: "whisper",
          model: variant,
          state: installed ? "installed" : "missing",
          size_bytes: variant === "tiny.en" ? 75_000_000 : 1_600_000_000,
        }),
        row({ id: "rnnoise", state: "installed" }),
      ],
      { whisper_model: variant, ready: installed },
    );
  }

  it("shows adopted Fast inline, keeps explicit Best selected, and resumes the original request once", async () => {
    let installed = false;
    fetchStatus.mockImplementation((variant) =>
      Promise.resolve(
        variantStatus(
          variant ?? "large-v3-turbo",
          variant !== "tiny.en" || installed,
        ),
      ),
    );
    const found = deferred<BootstrapJobSnapshot | null>();
    fetchJob.mockReturnValue(found.promise);
    const fast = job({
      id: "inline-fast",
      whisper_model: "tiny.en",
      download: { component: "whisper", bytes: 25_000_000, total: 75_000_000 },
    });
    cancel.mockResolvedValue(fast);
    const resume = vi.fn();
    function Consumer() {
      const models = useModels();
      const recovery = useModelResume<typeof fastNeed>(resume);
      return (
        <>
          <button onClick={() => models.whisper.choose("large-v3-turbo")}>
            Choose Best
          </button>
          <button onClick={() => recovery.stopFor(fastNeed)}>
            Refuse Fast
          </button>
          <output aria-label="Selected">{models.whisper.variant}</output>
          <output aria-label="Ready">{String(models.ready)}</output>
          <output aria-label="Stopped">
            {recovery.stop ? "waiting" : "idle"}
          </output>
          {recovery.stop && <ModelNeedRow model={recovery.stop} />}
        </>
      );
    }
    render(
      <ModelsProvider>
        <Consumer />
      </ModelsProvider>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Ready")).toHaveTextContent("true"),
    );
    fireEvent.click(screen.getByText("Choose Best"));
    await act(async () => found.resolve(fast));
    await waitFor(() => expect(waiters).toHaveLength(1));
    fireEvent.click(screen.getByText("Refuse Fast"));
    expect(await screen.findByText("25 MB of 75 MB")).toBeVisible();
    expect(screen.getByLabelText("Selected")).toHaveTextContent(
      "large-v3-turbo",
    );
    expect(screen.getByLabelText("Ready")).toHaveTextContent("true");
    expect(screen.getByLabelText("Stopped")).toHaveTextContent("waiting");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Cancel the transcription model download",
      }),
    );
    await waitFor(() =>
      expect(cancel).toHaveBeenCalledExactlyOnceWith("inline-fast"),
    );
    expect(resume).not.toHaveBeenCalled();
    installed = true;
    await act(async () => waiters[0]!.finish({ ...fast, status: "cancelled" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Stopped")).toHaveTextContent("idle"),
    );
    expect(resume).toHaveBeenCalledExactlyOnceWith(fastNeed);
    expect(resume.mock.calls[0]?.[0]).toBe(fastNeed);
    expect(fetchStatus).toHaveBeenCalledWith("tiny.en");
    expect(screen.getByLabelText("Selected")).toHaveTextContent(
      "large-v3-turbo",
    );
    expect(screen.getByLabelText("Ready")).toHaveTextContent("true");
    fireEvent.click(screen.getByText("Choose Best"));
    await act(async () => {});
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("keeps concurrent Fast and Balanced freshness independent of Best", async () => {
    const fast = deferred<BootstrapStatus>();
    const balanced = deferred<BootstrapStatus>();
    fetchStatus.mockImplementation((variant) =>
      variant === "tiny.en"
        ? fast.promise
        : variant === "small.en"
          ? balanced.promise
          : Promise.resolve(variantStatus("large-v3-turbo", true)),
    );
    const resumedFast = vi.fn();
    const resumedBalanced = vi.fn();
    const balancedNeed = { ...fastNeed, variant: "small.en", size: "500 MB" };
    const { result } = renderHook(
      () => ({
        models: useModels(),
        fast: useModelResume<typeof fastNeed>(resumedFast),
        balanced: useModelResume<typeof balancedNeed>(resumedBalanced),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.models.ready).toBe(true));
    act(() => {
      result.current.fast.stopFor(fastNeed);
      result.current.balanced.stopFor(balancedNeed);
    });
    await act(async () => fast.resolve(variantStatus("tiny.en", true)));
    await waitFor(() =>
      expect(resumedFast).toHaveBeenCalledExactlyOnceWith(fastNeed),
    );
    expect(result.current.balanced.stop).toBe(balancedNeed);
    expect(result.current.models.whisper.variant).toBe("large-v3-turbo");
    expect(result.current.models.ready).toBe(true);
    await act(async () => balanced.resolve(variantStatus("small.en", true)));
    expect(resumedBalanced).toHaveBeenCalledExactlyOnceWith(balancedNeed);
    expect(result.current.balanced.stop).toBeNull();
  });

  it("rejects superseded Fast success and a newer failed read, then resumes the latest request", async () => {
    const obsolete = deferred<BootstrapStatus>();
    const newer = deferred<BootstrapStatus>();
    const retry = deferred<BootstrapStatus>();
    const targetReads = [obsolete, newer, retry];
    fetchStatus.mockImplementation((variant) =>
      variant === "tiny.en"
        ? (targetReads.shift()?.promise ??
          Promise.resolve(variantStatus("tiny.en", true)))
        : Promise.resolve(variantStatus(variant ?? "large-v3-turbo", true)),
    );
    const resume = vi.fn();
    const { result } = renderHook(
      () => ({
        models: useModels(),
        recovery: useModelResume<typeof fastNeed>(resume),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.models.ready).toBe(true));
    act(() => result.current.recovery.stopFor(fastNeed));
    const original = {
      ...fastNeed,
      request: { operation: "latest", revision: 8 },
    };
    act(() => result.current.recovery.stopFor(original));
    await act(async () => result.current.models.whisper.choose("small.en"));
    await act(async () => obsolete.resolve(variantStatus("tiny.en", true)));
    expect(result.current.recovery.stop).toBe(original);
    expect(resume).not.toHaveBeenCalled();
    await act(async () => newer.reject(new Error("Target status offline")));
    expect(result.current.recovery.stop).toBe(original);
    act(() => {
      void result.current.models.refresh();
    });
    await act(async () => retry.resolve(variantStatus("tiny.en", true)));
    await waitFor(() =>
      expect(resume).toHaveBeenCalledExactlyOnceWith(original),
    );
    expect(result.current.recovery.stop).toBeNull();
    expect(result.current.models.whisper.variant).toBe("small.en");
  });

  it("checks non-Whisper readiness on the machine without using its metadata as a Whisper size", async () => {
    fetchStatus.mockImplementation((variant) =>
      Promise.resolve(variantStatus(variant ?? "large-v3-turbo")),
    );
    const resume = vi.fn();
    const need: NeedTarget = {
      id: "rnnoise",
      variant: "rnnoise-model-v1",
      label: "RNNoise",
      size: "0.3 MB",
    };
    const { result } = renderHook(
      () => ({
        models: useModels(),
        recovery: useModelResume<NeedTarget>(resume),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.models.models).not.toBeNull());
    act(() => result.current.models.whisper.choose("small.en"));
    await waitFor(() =>
      expect(result.current.models.models?.[0]?.variant).toBe("small.en"),
    );
    act(() => result.current.recovery.stopFor(need));
    await waitFor(() => expect(resume).toHaveBeenCalledExactlyOnceWith(need));
    expect(fetchStatus).toHaveBeenLastCalledWith("small.en");
    expect(fetchStatus).not.toHaveBeenCalledWith("rnnoise-model-v1");
    expect(result.current.models.whisper.variant).toBe("small.en");
    expect(result.current.models.models?.[0]?.state.kind).toBe("missing");
  });
});

describe("target update ownership", () => {
  it("forces Update after the model state commits while leaving Best selected", async () => {
    let selected: ReturnType<typeof useModels> | undefined;
    const observer = new MutationObserver(() => {
      const update = screen.queryByRole("button", {
        name: "Update the transcription model",
      });
      if (
        !update?.isConnected ||
        update.hasAttribute("disabled") ||
        update.getAttribute("aria-disabled") === "true"
      ) {
        return;
      }
      observer.disconnect();
      expect(selected?.whisper.variant).toBe("large-v3-turbo");
      expect(
        selected?.lookup({ id: "whisper", variant: "tiny.en" }).row?.state,
      ).toEqual({ kind: "update_needed" });
      fireEvent.click(update);
    });

    try {
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ["disabled", "aria-disabled"],
        childList: true,
        subtree: true,
      });
      fetchStatus.mockImplementation((variant) =>
        Promise.resolve(
          status(
            [
              row({
                id: "whisper",
                model: variant ?? "large-v3-turbo",
                state: variant === "tiny.en" ? "update_needed" : "installed",
              }),
            ],
            {
              whisper_model: variant ?? "large-v3-turbo",
              ready: variant !== "tiny.en",
            },
          ),
        ),
      );
      run.mockResolvedValue({
        job: job({ id: "fast-update", whisper_model: "tiny.en" }),
      });
      function TestObserve() {
        const models = useModels();
        useLayoutEffect(() => {
          selected = models;
        }, [models]);
        return null;
      }
      render(
        <ModelsProvider>
          <TestObserve />
          <ModelNeedRow
            model={{
              id: "whisper",
              variant: "tiny.en",
              label: "Whisper",
              size: "75 MB",
            }}
          />
        </ModelsProvider>,
      );
      await waitFor(() =>
        expect(run).toHaveBeenCalledExactlyOnceWith({
          components: ["whisper"],
          whisper_model: "tiny.en",
          force: true,
        }),
      );
      expect(selected?.whisper.variant).toBe("large-v3-turbo");
      expect(selected?.models?.[0]?.state).toEqual({ kind: "installed" });
      expect(
        await screen.findByRole("button", {
          name: "Cancel the transcription model download",
        }),
      ).toBeEnabled();
    } finally {
      observer.disconnect();
    }
  });

  it("forces an observed Fast update while leaving Best selected", async () => {
    fetchStatus.mockImplementation((variant) =>
      Promise.resolve(
        status(
          [
            row({
              id: "whisper",
              model: variant ?? "large-v3-turbo",
              state: variant === "tiny.en" ? "update_needed" : "installed",
            }),
          ],
          {
            whisper_model: variant ?? "large-v3-turbo",
            ready: variant !== "tiny.en",
          },
        ),
      ),
    );
    run.mockResolvedValue({
      job: job({ id: "fast-update", whisper_model: "tiny.en" }),
    });
    let selected: ReturnType<typeof useModels> | undefined;
    function Observe() {
      selected = useModels();
      return null;
    }
    render(
      <ModelsProvider>
        <Observe />
        <ModelNeedRow
          model={{
            id: "whisper",
            variant: "tiny.en",
            label: "Whisper",
            size: "75 MB",
          }}
        />
      </ModelsProvider>,
    );
    const update = await screen.findByRole("button", {
      name: "Update the transcription model",
    });
    expect(selected?.whisper.variant).toBe("large-v3-turbo");
    fireEvent.click(update);
    await waitFor(() =>
      expect(run).toHaveBeenCalledExactlyOnceWith({
        components: ["whisper"],
        whisper_model: "tiny.en",
        force: true,
      }),
    );
    expect(selected?.whisper.variant).toBe("large-v3-turbo");
    expect(selected?.models?.[0]?.state).toEqual({ kind: "installed" });
    expect(
      await screen.findByRole("button", {
        name: "Cancel the transcription model download",
      }),
    ).toBeEnabled();
  });
});

describe("Models update menu focus", () => {
  it("hands keyboard focus to Cancel and then honors focus moved to another row", async () => {
    fetchStatus.mockResolvedValue(
      status([
        row({ id: "whisper", model: "large-v3-turbo", state: "installed" }),
        row({ id: "rnnoise", state: "update_needed" }),
      ]),
    );
    const starting = deferred<Awaited<ReturnType<typeof api.runBootstrap>>>();
    run.mockReturnValueOnce(starting.promise);
    stubViewportShell("desktop");
    render(
      <ModelsProvider>
        <ModelsSheet open onClose={vi.fn()} />
      </ModelsProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus(),
    );
    const more = await screen.findByRole("button", {
      name: "More for Noise reduction",
    });
    more.focus();
    await userEvent.keyboard("{Enter}");
    const update = await screen.findByRole("menuitem", {
      name: "Update Noise reduction",
    });
    await waitFor(() => expect(update).toHaveFocus());
    await userEvent.keyboard("{Enter}");
    const cancelButton = await screen.findByRole("button", {
      name: "Cancel Noise reduction download",
    });
    expect(cancelButton).toHaveFocus();
    const elsewhere = screen.getByRole("button", {
      name: "More for Transcription",
    });
    await userEvent.click(elsewhere);
    await userEvent.keyboard("{Escape}");
    expect(elsewhere).toHaveFocus();
    const downloading = job({ id: "focus-update", components: ["rnnoise"] });
    await act(async () => starting.resolve({ job: downloading }));
    await waitFor(() => expect(waiters).toHaveLength(1));
    act(() =>
      waiters[0]!.onUpdate({
        ...downloading,
        download: { component: "rnnoise", bytes: 10, total: 100 },
      }),
    );
    expect(elsewhere).toHaveFocus();
    await act(async () =>
      waiters[0]!.finish({ ...downloading, status: "cancelled" }),
    );
    expect(elsewhere).toHaveFocus();
  });
});
