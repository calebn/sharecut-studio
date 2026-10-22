import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const runBootstrap = vi.fn();
const waitForBootstrapJob = vi.fn();

vi.mock("../api", () => ({
  runBootstrap: (...args: unknown[]) => runBootstrap(...args),
  waitForBootstrapJob: (...args: unknown[]) => waitForBootstrapJob(...args),
}));

import { WhisperDownloadDialog } from "./WhisperModelPicker";

describe("WhisperDownloadDialog", () => {
  it("hides the environment variable and path in a failed download", async () => {
    const user = userEvent.setup();
    runBootstrap.mockRejectedValue(
      new Error(
        "whisper: no download source: set PODCAST_BOOTSTRAP_CDN_BASE or place the file at /home/x/.cache/p/models/w/m.bin",
      ),
    );
    render(
      <WhisperDownloadDialog
        pending={{ modelId: "small", reason: "select" }}
        models={[
          {
            id: "small",
            label: "Small",
            size: "~460 MB",
            cached: false,
          } as never,
        ]}
        onDefer={vi.fn()}
        onCancel={vi.fn()}
        onDownloaded={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't download the Whisper model. Export diagnostics from the command palette and try again.",
    );
  });

  it("shows no raw progress text next to the alert after a failed job", async () => {
    const user = userEvent.setup();
    const raw = "whisper: model small not found";
    runBootstrap.mockResolvedValue({
      job: { id: "job1", status: "running", message: "Starting…" },
    });
    waitForBootstrapJob.mockImplementation(
      async (
        _id: string,
        opts?: { onUpdate?: (job: { message: string }) => void },
      ) => {
        opts?.onUpdate?.({ message: raw });
        throw new Error(raw);
      },
    );
    render(
      <WhisperDownloadDialog
        pending={{ modelId: "small", reason: "select" }}
        models={[
          {
            id: "small",
            label: "Small",
            size: "~460 MB",
            cached: false,
          } as never,
        ]}
        onDefer={vi.fn()}
        onCancel={vi.fn()}
        onDownloaded={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Download" }));
    await screen.findByRole("alert");
    expect(screen.queryByText(raw)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
