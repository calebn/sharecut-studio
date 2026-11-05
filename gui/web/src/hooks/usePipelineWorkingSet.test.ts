import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPipelineConfig, putPipelineConfig } from "../api";
import { pipelineConfig } from "../test/pipelineConfigFixture";
import type { PipelineConfigResponse } from "../types/pipeline";
import { usePipelineWorkingSet } from "./usePipelineWorkingSet";

vi.mock("../api", () => ({
  loadPipelineConfig: vi.fn(),
  putPipelineConfig: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.mocked(loadPipelineConfig).mockReset();
  vi.mocked(putPipelineConfig).mockReset();
});

describe("pipeline working-set request ownership", () => {
  it("loads only while enabled and ignores the first same-path visit after reenable", async () => {
    const old = deferred<PipelineConfigResponse>();
    const fresh = deferred<PipelineConfigResponse>();
    vi.mocked(loadPipelineConfig)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise);
    const hook = renderHook(
      ({ enabled }) => usePipelineWorkingSet("/a", enabled),
      { initialProps: { enabled: false } },
    );
    expect(loadPipelineConfig).not.toHaveBeenCalled();
    hook.rerender({ enabled: true });
    hook.rerender({ enabled: false });
    hook.rerender({ enabled: true });
    await act(async () => old.resolve(pipelineConfig({ unattended: true })));
    expect(hook.result.current.cfg).toBeNull();
    const expected = pipelineConfig();
    await act(async () => fresh.resolve(expected));
    expect(hook.result.current.cfg).toBe(expected);
  });

  it("serializes same-event recipes and reads fresh settings before every save", async () => {
    const firstSave = deferred<PipelineConfigResponse>();
    const initial = pipelineConfig();
    const fresh1 = pipelineConfig({ enabled_steps: ["external-one"] });
    const saved1 = pipelineConfig({ ...fresh1, unattended: true });
    const fresh2 = pipelineConfig({
      ...saved1,
      enabled_steps: ["external-two"],
    });
    const saved2 = pipelineConfig({
      ...fresh2,
      enabled_steps: [...fresh2.enabled_steps, "mine"],
    });
    vi.mocked(loadPipelineConfig)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(fresh1)
      .mockResolvedValueOnce(fresh2);
    vi.mocked(putPipelineConfig)
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce(saved2);
    const hook = renderHook(() => usePipelineWorkingSet("/a", true));
    await waitFor(() => expect(hook.result.current.cfg).toBe(initial));
    let one!: Promise<boolean>;
    let two!: Promise<boolean>;
    act(() => {
      one = hook.result.current.update(() => ({ unattended: true }));
      two = hook.result.current.update((current) => ({
        enabled_steps: [...current.enabled_steps, "mine"],
      }));
    });
    await waitFor(() => expect(putPipelineConfig).toHaveBeenCalledTimes(1));
    expect(loadPipelineConfig).toHaveBeenCalledTimes(2);
    expect(hook.result.current.saving).toBe(true);
    await act(async () => {
      firstSave.resolve(saved1);
      await Promise.all([one, two]);
    });
    expect(putPipelineConfig).toHaveBeenNthCalledWith(1, "/a", {
      unattended: true,
    });
    expect(putPipelineConfig).toHaveBeenNthCalledWith(2, "/a", {
      enabled_steps: ["external-two", "mine"],
    });
    expect(hook.result.current.cfg).toBe(saved2);
    expect(hook.result.current.saving).toBe(false);
  });

  it("reload immediately retires queued commands before React rerenders", async () => {
    vi.mocked(loadPipelineConfig)
      .mockResolvedValueOnce(pipelineConfig())
      .mockReturnValueOnce(new Promise(() => {}));
    const hook = renderHook(() => usePipelineWorkingSet("/a", true));
    await waitFor(() => expect(hook.result.current.cfg).not.toBeNull());
    let pending!: Promise<boolean>;
    act(() => {
      pending = hook.result.current.update(() => ({ unattended: true }));
      hook.result.current.reload();
    });
    await act(async () => expect(await pending).toBe(false));
    expect(putPipelineConfig).not.toHaveBeenCalled();
    expect(hook.result.current.cfg).toBeNull();
    expect(hook.result.current.saving).toBe(false);
  });

  it("keeps a newer read authoritative when an older save finishes", async () => {
    const save = deferred<PipelineConfigResponse>();
    const initial = pipelineConfig();
    const newer = pipelineConfig({ enabled_steps: ["newer"] });
    const last = pipelineConfig({ enabled_steps: ["newer", "last"] });
    vi.mocked(loadPipelineConfig)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(newer)
      .mockResolvedValueOnce(newer);
    vi.mocked(putPipelineConfig)
      .mockReturnValueOnce(save.promise)
      .mockResolvedValueOnce(last);
    const hook = renderHook(() => usePipelineWorkingSet("/a", true));
    await waitFor(() => expect(hook.result.current.cfg).toBe(initial));
    let pending!: Promise<boolean>;
    act(() => {
      pending = hook.result.current.update(() => ({ unattended: true }));
    });
    await waitFor(() => expect(putPipelineConfig).toHaveBeenCalledTimes(1));
    await act(async () => {
      expect(await hook.result.current.fetchFresh()).toBe(newer);
    });
    await act(async () => {
      save.resolve(pipelineConfig({ unattended: true }));
      expect(await pending).toBe(false);
    });
    expect(hook.result.current.cfg).toBe(newer);
    await act(async () => {
      await hook.result.current.update((current) => ({
        enabled_steps: [...current.enabled_steps, "last"],
      }));
    });
    expect(putPipelineConfig).toHaveBeenLastCalledWith("/a", {
      enabled_steps: ["newer", "last"],
    });
    expect(hook.result.current.cfg).toBe(last);
  });

  it("does not publish a retired save error or finally into a new project", async () => {
    const oldSave = deferred<PipelineConfigResponse>();
    const next = pipelineConfig({ enabled_steps: ["next"] });
    vi.mocked(loadPipelineConfig)
      .mockResolvedValueOnce(pipelineConfig())
      .mockResolvedValueOnce(pipelineConfig())
      .mockResolvedValueOnce(next);
    vi.mocked(putPipelineConfig).mockReturnValueOnce(oldSave.promise);
    const hook = renderHook(({ path }) => usePipelineWorkingSet(path, true), {
      initialProps: { path: "/a" },
    });
    await waitFor(() => expect(hook.result.current.cfg).not.toBeNull());
    let pending!: Promise<boolean>;
    act(() => {
      pending = hook.result.current.update(() => ({ unattended: true }));
    });
    await waitFor(() => expect(putPipelineConfig).toHaveBeenCalledTimes(1));
    hook.rerender({ path: "/b" });
    await waitFor(() => expect(hook.result.current.cfg).toBe(next));
    await act(async () => {
      oldSave.reject(new Error("old write"));
      expect(await pending).toBe(false);
    });
    expect(hook.result.current.cfg).toBe(next);
    expect(hook.result.current.saveError).toBeNull();
    expect(hook.result.current.saving).toBe(false);
  });

  it("recovers after a failed save without poisoning the serial queue", async () => {
    const initial = pipelineConfig();
    const saved = pipelineConfig({ unattended: true });
    vi.mocked(loadPipelineConfig).mockResolvedValue(initial);
    vi.mocked(putPipelineConfig)
      .mockRejectedValueOnce(new Error("write denied"))
      .mockResolvedValueOnce(saved);
    const hook = renderHook(() => usePipelineWorkingSet("/a", true));
    await waitFor(() => expect(hook.result.current.cfg).toBe(initial));
    await act(async () => {
      await expect(
        hook.result.current.update(() => ({ unattended: true })),
      ).rejects.toThrow("write denied");
    });
    expect(hook.result.current.cfg).toBe(initial);
    expect(hook.result.current.saveError).toBe("write denied");
    expect(hook.result.current.saving).toBe(false);
    await act(async () => {
      expect(
        await hook.result.current.update(() => ({ unattended: true })),
      ).toBe(true);
    });
    expect(hook.result.current.cfg).toBe(saved);
    expect(hook.result.current.saveError).toBeNull();
  });
  it("accepts a fresh-read command in the same event as reload", async () => {
    const reload = deferred<PipelineConfigResponse>();
    const fresh = pipelineConfig({ enabled_steps: ["fresh-command"] });
    vi.mocked(loadPipelineConfig)
      .mockResolvedValueOnce(pipelineConfig())
      .mockReturnValueOnce(reload.promise)
      .mockResolvedValueOnce(fresh);
    const hook = renderHook(() => usePipelineWorkingSet("/a", true));
    await waitFor(() => expect(hook.result.current.cfg).not.toBeNull());
    let result!: Promise<PipelineConfigResponse | null>;
    act(() => {
      hook.result.current.reload();
      result = hook.result.current.fetchFresh();
    });
    await act(async () => expect(await result).toBe(fresh));
    await act(async () => reload.resolve(pipelineConfig({ unattended: true })));
    expect(hook.result.current.cfg).toBe(fresh);
    expect(loadPipelineConfig).toHaveBeenCalledTimes(3);
  });
});
