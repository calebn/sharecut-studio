import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { modelStatus, modelsApi, registryRows } from "../test/renderWithModels";
import { ModelsContext } from "./useModels";
import { clearRetimeOffer, useWordTiming } from "./useWordTiming";

function open(path: string, transcribed: boolean) {
  useDawStore.setState({
    projectPath: path,
    project: minimalProject({
      transcript: transcribed ? { utterances: [{ id: "u" } as never] } : null,
    }),
  });
}

function installed(on: boolean) {
  const api = modelsApi({ status: modelStatus(registryRows()) });
  return {
    ...api,
    models:
      api.models?.map((m) =>
        m.id === "word-aligner" && on
          ? { ...m, state: { kind: "installed" as const } }
          : m,
      ) ?? null,
  };
}

function wrap(api: ReturnType<typeof installed>) {
  return ({ children }: { children: ReactNode }) => (
    <ModelsContext.Provider value={api}>{children}</ModelsContext.Provider>
  );
}

describe("useWordTiming", () => {
  it("remembers a transcript seen without the aligner, and forgets it once the re-time starts", async () => {
    const path = "/tmp/p/remember.sharecut";
    open(path, true);
    const missing = renderHook(() => useWordTiming(), {
      wrapper: wrap(installed(false)),
    });
    expect(missing.result.current.approximate).toBe(true);
    missing.unmount();
    const later = renderHook(() => useWordTiming(), {
      wrapper: wrap(installed(true)),
    });
    await waitFor(() => expect(later.result.current.retime).toBe(true));
    clearRetimeOffer(path);
    await waitFor(() => expect(later.result.current.retime).toBe(false));
  });

  it("keeps each project's offer apart", async () => {
    open("/tmp/p/one.sharecut", true);
    renderHook(() => useWordTiming(), {
      wrapper: wrap(installed(false)),
    }).unmount();
    open("/tmp/p/two.sharecut", true);
    const other = renderHook(() => useWordTiming(), {
      wrapper: wrap(installed(true)),
    });
    expect(other.result.current.retime).toBe(false);
  });

  it("offers nothing for a project with no transcript", () => {
    open("/tmp/p/empty.sharecut", false);
    const { result } = renderHook(() => useWordTiming(), {
      wrapper: wrap(installed(false)),
    });
    expect(result.current.approximate).toBe(false);
  });
});
