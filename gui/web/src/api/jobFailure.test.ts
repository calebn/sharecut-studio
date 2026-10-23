import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { isModelNeeded } from "../utils/apiError";
import { followJobToOk, jobFailure } from "./pipeline";

const MODEL = {
  id: "rnnoise",
  model: "rnnoise",
  label: "RNNoise",
  purpose: "noise reduction",
  size: "~2 MB",
  size_bytes: 2_000_000,
  command: "podcast bootstrap --component rnnoise",
  state: "missing",
};

function failed(extra: Partial<PipelineJobSnapshot>): PipelineJobSnapshot {
  return {
    id: "j1",
    project_path: "/tmp/p.json",
    from_step: null,
    only_step: null,
    kind: "export",
    status: "error",
    current: null,
    total: null,
    message: "needs RNNoise",
    error: "needs RNNoise (~2 MB)",
    elapsed_sec: 1,
    steps: [],
    ...extra,
  };
}

describe("jobFailure", () => {
  it("turns a model_needed snapshot into the error a model gate asks on", () => {
    const err = jobFailure(
      failed({ error_code: "model_needed", error_model: MODEL }),
      "Export failed",
    );
    expect(isModelNeeded(err)).toBe(true);
    if (!isModelNeeded(err)) return;
    expect(err.message).toBe("needs RNNoise (~2 MB)");
    expect(err.model).toEqual({
      id: "rnnoise",
      variant: "rnnoise",
      label: "RNNoise",
      purpose: "noise reduction",
      size: "~2 MB",
      sizeBytes: 2_000_000,
      state: "missing",
    });
    expect(JSON.stringify(err.model)).not.toContain("bootstrap");
  });

  it("keeps a plain Error for another code, a bad payload or no code", () => {
    for (const extra of [
      { error_code: "no_mix", error_model: MODEL },
      { error_code: "model_needed", error_model: { id: "rnnoise" } },
      { error_code: "model_needed", error_model: null },
      {},
    ]) {
      const err = jobFailure(failed(extra), "Export failed");
      expect(isModelNeeded(err)).toBe(false);
      expect(err.message).toBe("needs RNNoise (~2 MB)");
    }
  });

  it("falls back to the label when the snapshot has no text", () => {
    expect(
      jobFailure(failed({ error: null, message: null }), "Export failed")
        .message,
    ).toBe("Export failed");
  });
});

describe("followJobToOk", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws the model error for a failed job that names its model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              running: false,
              job: failed({ error_code: "model_needed", error_model: MODEL }),
            }),
            { status: 200 },
          ),
      ),
    );
    const err = await followJobToOk("j1", "Export failed").catch(
      (e: unknown) => e,
    );
    expect(isModelNeeded(err)).toBe(true);
  });
});
