import { act, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { BootstrapStatus } from "../api";
import * as api from "../api";
import { modelStatus, modelsApi, registryRows } from "../test/renderWithModels";
import type { ModelNeeded } from "../utils/apiError";
import { ModelsProvider } from "./ModelsProvider";
import { useModelResume } from "./useModelResume";
import { ModelsContext, useModels } from "./useModels";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  fetchBootstrapStatus: vi.fn(),
  fetchBootstrapJob: vi.fn().mockResolvedValue(null),
}));

function deferredStatus() {
  let resolve!: (status: BootstrapStatus) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<BootstrapStatus>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function ProviderHarness({ resume }: { resume: () => void }) {
  const models = useModels();
  const { stop, stopFor, clear } = useModelResume(resume);
  return (
    <>
      <button
        disabled={models.models === null}
        onClick={() => stopFor(RNNOISE)}
      >
        Refuse
      </button>
      <button onClick={() => void models.refresh()}>Retry status</button>
      <button onClick={clear}>Clear</button>
      <output aria-label="Resume state">{stop ? "waiting" : "idle"}</output>
    </>
  );
}

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
  it("keeps the refusal after a failed real-provider read, then recovers once from fresh evidence", async () => {
    const failed = deferredStatus();
    const retry = deferredStatus();
    const installed = modelStatus(rows(true));
    vi.mocked(api.fetchBootstrapStatus)
      .mockReset()
      .mockResolvedValueOnce(installed)
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retry.promise)
      .mockResolvedValue(installed);
    const resume = vi.fn();
    render(
      <ModelsProvider>
        <ProviderHarness resume={resume} />
      </ModelsProvider>,
    );
    await waitFor(() => expect(screen.getByText("Refuse")).toBeEnabled());
    await act(async () => screen.getByText("Refuse").click());
    await act(async () => failed.reject(new Error("Status offline")));
    expect(screen.getByLabelText("Resume state")).toHaveTextContent("waiting");
    expect(resume).not.toHaveBeenCalled();
    await act(async () => screen.getByText("Retry status").click());
    await act(async () => retry.resolve(installed));
    expect(screen.getByLabelText("Resume state")).toHaveTextContent("idle");
    expect(resume).toHaveBeenCalledExactlyOnceWith(RNNOISE);
    await act(async () => screen.getByText("Retry status").click());
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("does not authorize replay from a superseded response or a newer failed read", async () => {
    const obsolete = deferredStatus();
    const newer = deferredStatus();
    const installed = modelStatus(rows(true));
    vi.mocked(api.fetchBootstrapStatus)
      .mockReset()
      .mockResolvedValueOnce(installed)
      .mockReturnValueOnce(obsolete.promise)
      .mockReturnValueOnce(newer.promise)
      .mockResolvedValue(installed);
    const resume = vi.fn();
    render(
      <ModelsProvider>
        <ProviderHarness resume={resume} />
      </ModelsProvider>,
    );
    await waitFor(() => expect(screen.getByText("Refuse")).toBeEnabled());
    await act(async () => screen.getByText("Refuse").click());
    await act(async () => screen.getByText("Retry status").click());
    await act(async () => obsolete.resolve(installed));
    expect(screen.getByLabelText("Resume state")).toHaveTextContent("waiting");
    expect(resume).not.toHaveBeenCalled();
    await act(async () => newer.reject(new Error("Newer read failed")));
    expect(screen.getByLabelText("Resume state")).toHaveTextContent("waiting");
    await act(async () => screen.getByText("Retry status").click());
    expect(screen.getByLabelText("Resume state")).toHaveTextContent("idle");
    expect(resume).toHaveBeenCalledExactlyOnceWith(RNNOISE);
  });
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
