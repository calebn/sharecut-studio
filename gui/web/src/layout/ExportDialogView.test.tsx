import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import {
  ExportDialogView,
  type ExportDialogViewProps,
  type ExportStage,
} from "./ExportDialogView";
import { exportSettingsFromConfig } from "./exportSettings";

const LOADING = "Wait for the export settings to load.";

const settings = exportSettingsFromConfig({
  export: {
    wav: true,
    formats: [{ ext: "mp3", codec: "libmp3lame", bitrate_kbps: 128 }],
  },
  master: { integrated_lufs: -16, true_peak_db: -1.5 },
});

function renderStage(stage: ExportStage) {
  const props: ExportDialogViewProps = {
    open: true,
    onClose: vi.fn(),
    stage,
    onToggleFormat: vi.fn(),
    onExport: vi.fn(),
    onCancelExport: vi.fn(),
    onRestart: vi.fn(),
  };
  return render(<ExportDialogView {...props} />);
}

describe("ExportDialogView", () => {
  it("shows why Export is disabled while the settings load", async () => {
    const { baseElement } = renderStage({
      kind: "configure",
      settings: null,
      settingsError: null,
      selected: [],
      blocker: null,
    });
    const exportButton = screen.getByRole("button", { name: "Export" });
    expect(exportButton).toBeDisabled();
    const note = screen.getByText(LOADING);
    expect(note).toBeVisible();
    expect(exportButton).toHaveAccessibleDescription(LOADING);
    await expectNoA11yViolations(baseElement);
  });

  it("links the blocker note to Export", async () => {
    const { baseElement } = renderStage({
      kind: "configure",
      settings,
      settingsError: null,
      selected: [],
      blocker: "Choose at least one format.",
    });
    const exportButton = screen.getByRole("button", { name: "Export" });
    expect(exportButton).toBeDisabled();
    const note = screen.getByText("Choose at least one format.");
    expect(exportButton).toHaveAttribute("aria-describedby", note.id);
    expect(exportButton).toHaveAccessibleDescription(
      "Choose at least one format.",
    );
    await expectNoA11yViolations(baseElement);
  });

  it("shows no note and no description once Export is enabled", () => {
    const { baseElement } = renderStage({
      kind: "configure",
      settings,
      settingsError: null,
      selected: [],
      blocker: null,
    });
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Export" })).not.toHaveAttribute(
      "aria-describedby",
    );
    expect(screen.queryByText(LOADING)).toBeNull();
    expect(
      baseElement.querySelector(".bounce-dialog-footer .export-dialog-note"),
    ).toBeNull();
  });

  it("enables Export when the settings failed to load", () => {
    renderStage({
      kind: "configure",
      settings: null,
      settingsError: "Couldn't load the Pipeline config.",
      selected: [],
      blocker: null,
    });
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
    expect(screen.queryByText(LOADING)).toBeNull();
  });
});
