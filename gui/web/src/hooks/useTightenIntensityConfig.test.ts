import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPipelineConfig, putPipelineConfig } from "../api";
import type { PipelineConfigResponse } from "../types/pipeline";
import { currentTightenIntensity } from "../utils/tightenIntensity";
import { useTightenIntensityConfig } from "./useTightenIntensityConfig";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  loadPipelineConfig: vi.fn(),
  putPipelineConfig: vi.fn(),
}));

function cfgWith(intensity: string): PipelineConfigResponse {
  return {
    defaults: {},
    config: { tighten: { intensity } },
    enabled_steps: [],
    unattended: true,
    steps: [],
    params: [
      {
        path: "tighten.intensity",
        label: "Tighten intensity",
        description: "x",
        type: "enum",
        enum: ["light", "medium", "aggressive"],
        default: "medium",
        group: "common",
        section: "tighten",
        affects: ["analyze_fillers_pauses"],
      },
    ],
    components: {},
    step_names: [],
  };
}

type Props = { path: string; enabled: boolean };

function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("useTightenIntensityConfig", () => {
  beforeEach(() => {
    vi.mocked(loadPipelineConfig).mockReset();
    vi.mocked(putPipelineConfig).mockReset();
  });

  it("ignores a late load for the previous project", async () => {
    const resolvers = new Map<string, (c: PipelineConfigResponse) => void>();
    vi.mocked(loadPipelineConfig).mockImplementation(
      (path) =>
        new Promise((r) => {
          resolvers.set(path, r);
        }),
    );
    const { result, rerender } = renderHook(
      ({ path, enabled }: Props) => useTightenIntensityConfig(path, enabled),
      { initialProps: { path: "/a.json", enabled: true } },
    );
    rerender({ path: "/b.json", enabled: true });
    expect(result.current.cfg).toBeNull();
    await act(async () => {
      resolvers.get("/b.json")?.(cfgWith("light"));
    });
    await act(async () => {
      resolvers.get("/a.json")?.(cfgWith("aggressive"));
    });
    expect(currentTightenIntensity(result.current.cfg)).toBe("light");
  });

  it("clears config when disabled", async () => {
    vi.mocked(loadPipelineConfig).mockResolvedValue(cfgWith("light"));
    const { result, rerender } = renderHook(
      ({ path, enabled }: Props) => useTightenIntensityConfig(path, enabled),
      { initialProps: { path: "/a.json", enabled: true } },
    );
    await waitFor(() => expect(result.current.cfg).not.toBeNull());
    rerender({ path: "/a.json", enabled: false });
    expect(result.current.cfg).toBeNull();
    expect(result.current.loadError).toBeNull();
  });

  it("fetchFresh returns null once the project changes", async () => {
    const late = deferred<PipelineConfigResponse>();
    vi.mocked(loadPipelineConfig)
      .mockResolvedValueOnce(cfgWith("light"))
      .mockImplementationOnce(() => late.promise)
      .mockResolvedValue(cfgWith("medium"));
    const { result, rerender } = renderHook(
      ({ path, enabled }: Props) => useTightenIntensityConfig(path, enabled),
      { initialProps: { path: "/a.json", enabled: true } },
    );
    await waitFor(() => expect(result.current.cfg).not.toBeNull());
    let p: Promise<PipelineConfigResponse | null> = Promise.resolve(null);
    act(() => {
      p = result.current.fetchFresh();
    });
    rerender({ path: "/b.json", enabled: true });
    await act(async () => {
      late.resolve(cfgWith("aggressive"));
    });
    await expect(p).resolves.toBeNull();
  });

  it("ignores a save for the old project after a project switch", async () => {
    const refetch = deferred<PipelineConfigResponse>();
    vi.mocked(loadPipelineConfig).mockImplementation((path) => {
      if (path === "/b.json") return Promise.resolve(cfgWith("aggressive"));
      return vi.mocked(loadPipelineConfig).mock.calls.length === 1
        ? Promise.resolve(cfgWith("medium"))
        : refetch.promise;
    });
    const { result, rerender } = renderHook(
      ({ path, enabled }: Props) => useTightenIntensityConfig(path, enabled),
      { initialProps: { path: "/a.json", enabled: true } },
    );
    await waitFor(() => expect(result.current.cfg).not.toBeNull());
    act(() => {
      void result.current.setIntensity("light");
    });
    rerender({ path: "/b.json", enabled: true });
    await waitFor(() =>
      expect(currentTightenIntensity(result.current.cfg)).toBe("aggressive"),
    );
    await act(async () => {
      refetch.resolve(cfgWith("medium"));
    });
    expect(putPipelineConfig).not.toHaveBeenCalled();
    expect(currentTightenIntensity(result.current.cfg)).toBe("aggressive");
  });
});
