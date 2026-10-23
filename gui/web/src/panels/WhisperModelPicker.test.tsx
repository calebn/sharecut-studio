import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import {
  type ModelsFixture,
  modelStatus,
  registryRows,
  renderWithModels,
} from "../test/renderWithModels";
import { WhisperDownloadDialog } from "./WhisperModelPicker";

const SMALL = {
  id: "small",
  label: "Small",
  size: "~460 MB",
  cached: false,
} as never;

function dialog(onDownloaded = vi.fn()) {
  return (
    <WhisperDownloadDialog
      pending={{ modelId: "small" }}
      models={[SMALL]}
      onDefer={vi.fn()}
      onCancel={vi.fn()}
      onDownloaded={onDownloaded}
    />
  );
}

function fixture(over: Partial<ModelsFixture> = {}): ModelsFixture {
  return { status: modelStatus(registryRows()), ...over };
}

describe("WhisperDownloadDialog", () => {
  it("downloads the pending size through the models controller", async () => {
    const user = userEvent.setup();
    const onDownloaded = vi.fn();
    const { api } = renderWithModels(dialog(onDownloaded), fixture());
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(api.download).toHaveBeenCalledWith(["whisper"], {
      whisperModel: "small",
    });
    await waitFor(() => expect(onDownloaded).toHaveBeenCalledWith("small"));
  });

  it("shows the plain failure of this attempt and keeps the dialog usable", async () => {
    const user = userEvent.setup();
    const onDownloaded = vi.fn();
    const failures = {
      whisper: {
        kind: "disk" as const,
        plain: "There isn't enough free disk space.",
      },
    };
    renderWithModels(
      dialog(onDownloaded),
      fixture({
        failures,
        download: vi.fn(async () => ({
          kind: "failed" as const,
          failed: ["whisper"],
        })),
      }),
    );
    // An older failure of the same model is not this dialog's news until it tries.
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "There isn't enough free disk space.",
    );
    expect(onDownloaded).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
  });

  it("shows a live byte bar and holds the dialog open while it downloads", async () => {
    const { baseElement } = renderWithModels(
      dialog(),
      fixture({
        job: {
          id: "j",
          kind: "bootstrap",
          components: ["whisper"],
          whisper_model: "small",
          status: "running",
          download: {
            component: "whisper",
            bytes: 46_000_000,
            total: 460_000_000,
          },
        },
      }),
    );
    expect(
      screen.getByRole("progressbar", { name: "Whisper" }),
    ).toHaveAttribute("aria-valuetext", "46 MB of 460 MB");
    expect(screen.getByRole("button", { name: "Downloading…" })).toBeDisabled();
    await expectNoA11yViolations(baseElement);
  });

  it("disables Download with the reason while a different model downloads", () => {
    renderWithModels(
      dialog(),
      fixture({
        job: {
          id: "j",
          kind: "bootstrap",
          components: ["rnnoise"],
          whisper_model: "large-v3-turbo",
          status: "running",
        },
      }),
    );
    const button = screen.getByRole("button", { name: "Download" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Another download is running");
  });
});
