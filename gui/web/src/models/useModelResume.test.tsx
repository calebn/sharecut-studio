import { act, render, screen } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { modelStatus, modelsApi, registryRows } from "../test/renderWithModels";
import type { ModelNeeded } from "../utils/apiError";
import { useModelResume } from "./useModelResume";
import { ModelsContext } from "./useModels";

const RNNOISE: ModelNeeded = {
  id: "rnnoise",
  variant: null,
  label: "Noise reduction (RNNoise)",
  purpose: "noise reduction",
  size: "~0.3 MB",
  sizeBytes: 297_646,
  state: "missing",
};

function rows(installed: boolean) {
  return registryRows().map((r) =>
    r.id === "rnnoise" && installed ? { ...r, state: "installed" as const } : r,
  );
}

let setInstalled: (on: boolean) => void = () => undefined;

function Machine({
  children,
  startInstalled,
}: {
  children: ReactNode;
  startInstalled: boolean;
}) {
  const [installed, set] = useState(startInstalled);
  setInstalled = set;
  const api = modelsApi({ status: modelStatus(rows(installed)) });
  return (
    <ModelsContext.Provider value={api}>{children}</ModelsContext.Provider>
  );
}

function Harness({ resume }: { resume: () => void }) {
  const { stop, stopFor } = useModelResume(resume);
  return (
    <>
      <button type="button" onClick={() => stopFor(RNNOISE)}>
        Stop
      </button>
      <output>{stop ? "waiting" : "idle"}</output>
    </>
  );
}

async function stopped(resume: () => void, startInstalled: boolean) {
  render(
    <Machine startInstalled={startInstalled}>
      <Harness resume={resume} />
    </Machine>,
  );
  await act(async () => screen.getByRole("button", { name: "Stop" }).click());
}

describe("useModelResume", () => {
  it("waits while the model is missing, then resumes once when it lands", async () => {
    const resume = vi.fn();
    await stopped(resume, false);
    expect(screen.getByRole("status").textContent).toBe("waiting");
    expect(resume).not.toHaveBeenCalled();
    await act(async () => setInstalled(true));
    expect(resume).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledWith(RNNOISE);
    expect(screen.getByRole("status").textContent).toBe("idle");
    await act(async () => setInstalled(false));
    await act(async () => setInstalled(true));
    expect(resume).toHaveBeenCalledOnce();
  });

  it("resumes at once when the fresh status already has the model", async () => {
    const resume = vi.fn();
    await stopped(resume, true);
    expect(resume).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toBe("idle");
  });
});
