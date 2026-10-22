import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { ANOTHER_DOWNLOAD_REASON } from "../models";
import { expectNoA11yViolations } from "../test/a11y";
import {
  type ModelsFixture,
  modelRow,
  modelStatus,
  renderWithModels,
} from "../test/renderWithModels";
import { BUSY_REASON } from "../ui/disabledReason";
import { WordAlignerStatus } from "./WordAlignerStatus";

const ALIGNER = modelRow({
  id: "word-aligner",
  label: "Word aligner",
  purpose: "precise word boundaries",
  size: "~360 MB",
  size_bytes: null,
});

function fixture(over: Partial<ModelsFixture> = {}): ModelsFixture {
  return { status: modelStatus([ALIGNER]), ...over };
}

const MISSING = { state: "missing", tier: "offered", size: "~360 MB" } as const;
const INSTALLED = {
  state: "installed",
  tier: "offered",
  size: "~360 MB",
} as const;

function aligner(
  props: Partial<ComponentProps<typeof WordAlignerStatus>> = {},
) {
  return (
    <WordAlignerStatus
      status={MISSING}
      retiming={false}
      onDownloaded={vi.fn()}
      onRetime={vi.fn()}
      {...props}
    />
  );
}

const DOWNLOAD = { name: "Download word aligner" };

describe("WordAlignerStatus", () => {
  it("shows the needs-download message when not installed", () => {
    renderWithModels(aligner(), fixture());
    expect(
      screen.getByText(/Word aligner needs download \(~360 MB\)/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", DOWNLOAD)).toBeInTheDocument();
  });

  it("says an update-needed aligner needs downloading again", () => {
    renderWithModels(
      aligner({ status: { ...MISSING, state: "update_needed" } }),
      fixture(),
    );
    expect(
      screen.getByText(/does not match its pinned download \(~360 MB\)/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/needs download/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", DOWNLOAD)).toBeInTheDocument();
  });

  it("downloads through the models controller and calls onDownloaded", async () => {
    const user = userEvent.setup();
    const onDownloaded = vi.fn();
    const { api } = renderWithModels(aligner({ onDownloaded }), fixture());
    await user.click(screen.getByRole("button", DOWNLOAD));
    expect(api.download).toHaveBeenCalledWith(["word-aligner"], undefined);
    await waitFor(() => expect(onDownloaded).toHaveBeenCalled());
  });

  it("does not call onDownloaded when the download fails", async () => {
    const user = userEvent.setup();
    const onDownloaded = vi.fn();
    const { api } = renderWithModels(
      aligner({ onDownloaded }),
      fixture({
        download: vi.fn(async () => ({
          kind: "failed" as const,
          failed: ["word-aligner"],
        })),
      }),
    );
    await user.click(screen.getByRole("button", DOWNLOAD));
    await waitFor(() => expect(api.download).toHaveBeenCalled());
    expect(onDownloaded).not.toHaveBeenCalled();
  });

  it("shows the live byte bar and a busy button while it downloads", async () => {
    const { container } = renderWithModels(
      aligner(),
      fixture({
        job: {
          id: "j",
          kind: "bootstrap",
          components: ["word-aligner"],
          whisper_model: "",
          status: "running",
          download: {
            component: "word-aligner",
            bytes: 120_000_000,
            total: 360_000_000,
          },
        },
      }),
    );
    expect(
      screen.getByRole("progressbar", { name: "Word aligner" }),
    ).toHaveAttribute("aria-valuetext", "120 MB of 360 MB");
    const button = screen.getByRole("button", { name: "Downloading…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await expectNoA11yViolations(container);
  });

  it("shows the plain failure beside a button that can try again", async () => {
    const { container } = renderWithModels(
      aligner(),
      fixture({
        failures: {
          "word-aligner": {
            kind: "network",
            plain: "Couldn't reach the download server.",
          },
        },
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't reach the download server.",
    );
    expect(screen.getByRole("button", DOWNLOAD)).toBeEnabled();
    await expectNoA11yViolations(container);
  });

  it("disables Download with the reason while another model downloads", () => {
    renderWithModels(
      aligner(),
      fixture({
        status: modelStatus([
          ALIGNER,
          modelRow({ id: "whisper", tier: "required" }),
        ]),
        job: {
          id: "j",
          kind: "bootstrap",
          components: ["whisper"],
          whisper_model: "large-v3-turbo",
          status: "running",
        },
      }),
    );
    const button = screen.getByRole("button", DOWNLOAD);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", ANOTHER_DOWNLOAD_REASON);
  });

  it("shows downloaded and calls onRetime when installed", async () => {
    const user = userEvent.setup();
    const onRetime = vi.fn();
    renderWithModels(aligner({ status: INSTALLED, onRetime }), fixture());
    expect(
      screen.getByText(/Word aligner is downloaded \(~360 MB\)/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Re-time words" }));
    expect(onRetime).toHaveBeenCalled();
  });

  it("disables both the download and the re-time button", () => {
    const { rerender } = renderWithModels(
      aligner({ disabledReason: BUSY_REASON }),
      fixture(),
    );
    expect(screen.getByRole("button", DOWNLOAD)).toBeDisabled();

    rerender(aligner({ status: INSTALLED, disabledReason: BUSY_REASON }));
    expect(
      screen.getByRole("button", { name: "Re-time words" }),
    ).toBeDisabled();
  });

  it("locks to the download and names the reason when the aligner is missing", async () => {
    const { container } = renderWithModels(
      aligner({
        alignment: {
          enabled: false,
          model: null,
          requested: null,
          installed: false,
          blocked: false,
          reason:
            "unavailable: word aligner 'onnx-base' is not downloaded (podcast bootstrap --component word-aligner)",
        },
      }),
      fixture(),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Precise word boundaries unavailable: word aligner 'onnx-base' is not downloaded (podcast bootstrap --component word-aligner).",
    );
    expect(screen.getByRole("button", DOWNLOAD)).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Re-time words" }),
    ).not.toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("offers Re-time words when the aligner is downloaded and the field is on by default", async () => {
    const onRetime = vi.fn();
    const user = userEvent.setup();
    const { container } = renderWithModels(
      aligner({
        status: INSTALLED,
        onRetime,
        alignment: {
          enabled: true,
          model: "onnx-base",
          requested: null,
          installed: true,
          blocked: false,
          reason: "on by default: word aligner 'onnx-base' is installed",
        },
      }),
      fixture(),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Word aligner is downloaded (~360 MB). Precise word boundaries on by default: word aligner 'onnx-base' is installed.",
    );
    await user.click(screen.getByRole("button", { name: "Re-time words" }));
    expect(onRetime).toHaveBeenCalledTimes(1);
    await expectNoA11yViolations(container);
  });

  it("hides Re-time words when the field is explicitly off", () => {
    renderWithModels(
      aligner({
        status: INSTALLED,
        alignment: {
          enabled: false,
          model: null,
          requested: false,
          installed: true,
          blocked: false,
          reason: "off: transcribe.forced_alignment.enabled is false",
        },
      }),
      fixture(),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Precise word boundaries off: transcribe.forced_alignment.enabled is false.",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("has no axe violations when needing download", async () => {
    const { container } = renderWithModels(aligner(), fixture());
    await expectNoA11yViolations(container);
  });

  it("has no axe violations when downloaded", async () => {
    const { container } = renderWithModels(
      aligner({ status: INSTALLED }),
      fixture(),
    );
    await expectNoA11yViolations(container);
  });

  it("shows Re-timing… with aria-busy while retiming", async () => {
    const { container } = renderWithModels(
      aligner({
        status: INSTALLED,
        disabledReason: BUSY_REASON,
        retiming: true,
      }),
      fixture(),
    );
    const btn = screen.getByRole("button", { name: "Re-timing…" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(
      screen.queryByRole("button", { name: "Re-time words" }),
    ).not.toBeInTheDocument();
    await expectNoA11yViolations(container);
  });
});
