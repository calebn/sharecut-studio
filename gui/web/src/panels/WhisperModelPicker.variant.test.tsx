import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapJobSnapshot } from "../api";
import * as api from "../api";
import { ModelsProvider } from "../models/ModelsProvider";
import { modelRow, modelStatus, registryRows } from "../test/renderWithModels";
import { WhisperDownloadDialog } from "./WhisperModelPicker";

vi.mock("../api", () => ({
  fetchBootstrapStatus: vi.fn(),
  fetchBootstrapJob: vi.fn(),
  runBootstrap: vi.fn(),
  waitForBootstrapJob: vi.fn(),
  cancelBootstrap: vi.fn(),
}));

const fetchStatus = vi.mocked(api.fetchBootstrapStatus);
const run = vi.mocked(api.runBootstrap);
const wait = vi.mocked(api.waitForBootstrapJob);

const LARGE = {
  id: "large-v3",
  label: "Large",
  size: "~3 GB",
  cached: false,
} as never;

/** small.en is the installed host default; large-v3 is a different, uncached size. */
function statusFor(variant: string) {
  const rows = registryRows();
  rows[0] = modelRow({
    ...rows[0]!,
    model: variant,
    state:
      variant === "small.en" || variant === "large-v3-done"
        ? "installed"
        : "missing",
  });
  return modelStatus(rows, {
    whisper_model: variant === "large-v3-done" ? "large-v3" : variant,
  });
}

function job(): BootstrapJobSnapshot {
  return {
    id: "j1",
    kind: "bootstrap",
    components: ["whisper"],
    whisper_model: "large-v3",
    status: "running",
  };
}

function open(onDownloaded = vi.fn()) {
  return render(
    <ModelsProvider>
      <WhisperDownloadDialog
        pending={{ modelId: "large-v3" }}
        models={[LARGE]}
        onDefer={vi.fn()}
        onCancel={vi.fn()}
        onDownloaded={onDownloaded}
      />
    </ModelsProvider>,
  );
}

async function click() {
  const user = userEvent.setup();
  const button = await screen.findByRole("button", { name: "Download" });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchBootstrapJob).mockResolvedValue(null);
  fetchStatus.mockImplementation(async (variant?: string) =>
    statusFor(variant ?? "small.en"),
  );
});

describe("downloading a size other than the installed one", () => {
  it("shows the error when the start request fails", async () => {
    run.mockRejectedValue(new Error("Failed to fetch"));
    open();
    await click();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
  });

  it("shows the error when the connection is lost mid-download", async () => {
    run.mockResolvedValue({ job: job() });
    wait.mockRejectedValue(new Error("stream closed"));
    open();
    await click();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Lost the connection/,
    );
  });

  it("is installed for that size after a successful download", async () => {
    run.mockResolvedValue({ job: job() });
    wait.mockResolvedValue({ ...job(), status: "done" });
    fetchStatus.mockImplementation(async (variant?: string) =>
      statusFor(variant === "large-v3" ? "large-v3-done" : "small.en"),
    );
    const onDownloaded = vi.fn();
    open(onDownloaded);
    await click();
    await act(async () => {});
    await waitFor(() => expect(fetchStatus).toHaveBeenCalledWith("large-v3"));
    await waitFor(() => expect(onDownloaded).toHaveBeenCalledWith("large-v3"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
