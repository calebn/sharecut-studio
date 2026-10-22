import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { ModelRow, type ModelRowAction } from "./ModelRow";
import type { ModelState, ModelView } from "./types";

function view(state: ModelState, over: Partial<ModelView> = {}): ModelView {
  return {
    id: "whisper",
    label: "Whisper",
    purpose: "transcription",
    tier: "required",
    size: "~1.6 GB",
    sizeBytes: 1_600_000_000,
    variant: null,
    state,
    ...over,
  };
}

function renderRow(model: ModelView, action: ModelRowAction, picker?: boolean) {
  return render(
    <ul>
      <ModelRow
        model={model}
        action={action}
        variantPicker={picker ? <select aria-label="Size" /> : undefined}
      />
    </ul>,
  );
}

const download = (
  over: Partial<Extract<ModelRowAction, { kind: "download" }>> = {},
) => ({ kind: "download", onDownload: vi.fn(), ...over }) as const;

describe("ModelRow", () => {
  it.each([
    ["installed", { kind: "installed" }, "Installed"],
    ["missing", { kind: "missing" }, "Not downloaded"],
    ["update_needed", { kind: "update_needed" }, "Update available"],
    ["queued", { kind: "queued" }, "Waiting"],
    [
      "downloading",
      { kind: "downloading", bytes: 420_000_000, total: 1_600_000_000 },
      "Downloading",
    ],
    [
      "failed",
      {
        kind: "failed",
        failure: { kind: "network", plain: "Couldn't reach it." },
      },
      "Download failed",
    ],
  ] as const)(
    "names the %s state in text and is axe clean",
    async (_n, state, text) => {
      const { container } = renderRow(view(state), { kind: "none" });
      expect(screen.getByRole("status")).toHaveTextContent(text);
      expect(screen.getByText("Required")).toBeTruthy();
      expect(screen.getByText("~1.6 GB")).toBeTruthy();
      expect(screen.getByText("Transcription")).toBeTruthy();
      await expectNoA11yViolations(container);
    },
  );

  it("picks Download, Update or Retry by state", async () => {
    const user = userEvent.setup();
    const action = download();
    const { unmount } = renderRow(view({ kind: "missing" }), action);
    await user.click(screen.getByRole("button", { name: "Download Whisper" }));
    expect(action.onDownload).toHaveBeenCalledTimes(1);
    unmount();
    renderRow(view({ kind: "update_needed" }), download());
    expect(
      screen.getByRole("button", { name: "Update Whisper" }),
    ).toHaveTextContent("Update");
  });

  it("offers Retry beside the plain failure and its fix hint", async () => {
    const { container } = renderRow(
      view({
        kind: "failed",
        failure: { kind: "disk", plain: "Not enough free disk space." },
      }),
      download(),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Not enough free disk space.",
    );
    expect(screen.getByText(/Free some disk space/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry Whisper" })).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("gives an untyped failure the general hint", () => {
    renderRow(
      view({
        kind: "failed",
        failure: { kind: null, plain: "Whisper could not be installed." },
      }),
      download(),
    );
    expect(screen.getByText(/problem report/i)).toBeTruthy();
  });

  it("shows no button for installed, queued or downloading without a cancel", () => {
    for (const state of [
      { kind: "installed" },
      { kind: "queued" },
      { kind: "downloading", bytes: 1, total: 2 },
    ] as const) {
      const { unmount } = renderRow(view(state), download());
      expect(screen.queryByRole("button")).toBeNull();
      unmount();
    }
  });

  it("moves focus to Cancel when the clicked Download button gives way to the bar", async () => {
    const user = userEvent.setup();
    const missing = view({ kind: "missing" });
    const action = download({ onCancel: vi.fn() });
    const { rerender } = renderRow(missing, action);
    await user.click(screen.getByRole("button", { name: "Download Whisper" }));
    rerender(
      <ul>
        <ModelRow
          model={view({ kind: "downloading", bytes: 1, total: 2 })}
          action={action}
        />
      </ul>,
    );
    expect(
      screen.getByRole("button", { name: "Cancel Whisper download" }),
    ).toHaveFocus();
  });

  it("draws a real bar from bytes and total, spoken as 'N MB of M GB'", async () => {
    const { container } = renderRow(
      view({ kind: "downloading", bytes: 420_000_000, total: 1_600_000_000 }),
      { kind: "none" },
    );
    const bar = screen.getByRole("progressbar", { name: "Whisper" });
    expect(bar).toHaveAttribute("value", "420000000");
    expect(bar).toHaveAttribute("max", "1600000000");
    expect(bar).toHaveAttribute("aria-valuetext", "420 MB of 1.6 GB");
    await expectNoA11yViolations(container);
  });

  it("falls back to an indeterminate bar when the total is unknown", () => {
    renderRow(view({ kind: "downloading", bytes: 5_000_000, total: null }), {
      kind: "none",
    });
    const bar = screen.getByRole("progressbar");
    expect(bar).not.toHaveAttribute("value");
    expect(bar).toHaveAttribute("aria-valuetext", "5 MB downloaded");
  });

  it("offers Cancel while downloading when the owner allows it", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderRow(
      view({ kind: "downloading", bytes: 1, total: 2 }),
      download({ onCancel }),
    );
    await user.click(
      screen.getByRole("button", { name: "Cancel Whisper download" }),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables Download with a visible reason", async () => {
    const user = userEvent.setup();
    const action = download({ blockedReason: "Another download is running" });
    const { container } = renderRow(view({ kind: "missing" }), action);
    const button = screen.getByRole("button", { name: "Download Whisper" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Another download is running");
    await user.click(button);
    expect(action.onDownload).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("renders a select action as a checkbox named for the model, with the required note", async () => {
    const onToggle = vi.fn();
    const { container } = renderRow(view({ kind: "missing" }), {
      kind: "select",
      checked: true,
      locked: true,
      onToggle,
    });
    const box = screen.getByRole("checkbox", { name: "Whisper" });
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
    expect(box).toHaveAccessibleDescription(/Required for transcription/);
    await expectNoA11yViolations(container);
  });

  it("toggles an unlocked select and shows no required note for an optional model", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderRow(
      view({ kind: "missing" }, { tier: "offered", label: "Word aligner" }),
      {
        kind: "select",
        checked: false,
        locked: false,
        onToggle,
      },
    );
    await user.click(screen.getByRole("checkbox", { name: "Word aligner" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Required for/)).toBeNull();
    expect(screen.getByText("Optional")).toBeTruthy();
  });

  it("puts the variant picker inside the row", () => {
    renderRow(view({ kind: "missing" }), { kind: "none" }, true);
    expect(screen.getByRole("listitem")).toContainElement(
      screen.getByRole("combobox", { name: "Size" }),
    );
  });
});
