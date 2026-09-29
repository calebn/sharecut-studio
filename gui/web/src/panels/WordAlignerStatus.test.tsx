import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";

const runBootstrap = vi.fn();
const waitForBootstrapJob = vi.fn();

vi.mock("../api", () => ({
  runBootstrap: (...args: unknown[]) => runBootstrap(...args),
  waitForBootstrapJob: (...args: unknown[]) => waitForBootstrapJob(...args),
}));

import { WordAlignerStatus } from "./WordAlignerStatus";

describe("WordAlignerStatus", () => {
  it("shows the needs-download message when not ok", () => {
    render(
      <WordAlignerStatus
        status={{ ok: false, opt_in: true, size: "~360 MB" }}
        disabled={false}
        retiming={false}
        onDownloaded={vi.fn()}
        onRetime={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/Word aligner needs download \(~360 MB\)/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download word aligner" }),
    ).toBeInTheDocument();
  });

  it("says a pin-mismatched snapshot needs downloading again", () => {
    render(
      <WordAlignerStatus
        status={{
          ok: false,
          opt_in: true,
          size: "~360 MB",
          pin_mismatch: true,
        }}
        disabled={false}
        retiming={false}
        onDownloaded={vi.fn()}
        onRetime={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/does not match its pinned download \(~360 MB\)/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/needs download/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download word aligner" }),
    ).toBeInTheDocument();
  });

  it("downloads, shows progress, and calls onDownloaded", async () => {
    const user = userEvent.setup();
    const onDownloaded = vi.fn();
    runBootstrap.mockResolvedValue({
      job: { id: "job1", status: "running", message: "Starting…" },
    });
    waitForBootstrapJob.mockImplementation(
      async (_id: string, opts?: { onUpdate?: (job: unknown) => void }) => {
        opts?.onUpdate?.({
          id: "job1",
          status: "running",
          message: "Fetching weights…",
        });
        return { id: "job1", status: "ok", message: "Ready" };
      },
    );

    render(
      <WordAlignerStatus
        status={{ ok: false, opt_in: true, size: "~360 MB" }}
        disabled={false}
        retiming={false}
        onDownloaded={onDownloaded}
        onRetime={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Download word aligner" }),
    );
    expect(runBootstrap).toHaveBeenCalledWith({
      components: ["word-aligner"],
    });
    await waitFor(() => {
      expect(onDownloaded).toHaveBeenCalled();
    });
  });

  it("shows InlineError and re-enables the button on a rejected download", async () => {
    const user = userEvent.setup();
    runBootstrap.mockRejectedValue(new Error("network down"));

    render(
      <WordAlignerStatus
        status={{ ok: false, opt_in: true, size: "~360 MB" }}
        disabled={false}
        retiming={false}
        onDownloaded={vi.fn()}
        onRetime={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Download word aligner" }),
    );
    expect(await screen.findByText("network down")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download word aligner" }),
    ).toBeEnabled();
  });

  it("shows the server's busy message when another download holds the slot", async () => {
    const user = userEvent.setup();
    runBootstrap.mockRejectedValue(
      new Error(
        "Another download is already running (whisper); try again when it finishes",
      ),
    );

    render(
      <WordAlignerStatus
        status={{ ok: false, opt_in: true, size: "~360 MB" }}
        disabled={false}
        retiming={false}
        onDownloaded={vi.fn()}
        onRetime={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Download word aligner" }),
    );
    expect(
      await screen.findByText(
        /Another download is already running \(whisper\)/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download word aligner" }),
    ).toBeEnabled();
  });

  it("shows downloaded and calls onRetime when ok", async () => {
    const user = userEvent.setup();
    const onRetime = vi.fn();
    render(
      <WordAlignerStatus
        status={{ ok: true, opt_in: true, size: "~360 MB" }}
        disabled={false}
        retiming={false}
        onDownloaded={vi.fn()}
        onRetime={onRetime}
      />,
    );
    expect(
      screen.getByText(/Word aligner is downloaded \(~360 MB\)/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Re-time words" }));
    expect(onRetime).toHaveBeenCalled();
  });

  it("disables both the download and the re-time button", () => {
    const { rerender } = render(
      <WordAlignerStatus
        status={{ ok: false, opt_in: true, size: "~360 MB" }}
        disabled={true}
        retiming={false}
        onDownloaded={vi.fn()}
        onRetime={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Download word aligner" }),
    ).toBeDisabled();

    rerender(
      <WordAlignerStatus
        status={{ ok: true, opt_in: true, size: "~360 MB" }}
        disabled={true}
        retiming={false}
        onDownloaded={vi.fn()}
        onRetime={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Re-time words" }),
    ).toBeDisabled();
  });

  it("locks to the download and names the reason when the aligner is missing", async () => {
    const { container } = render(
      <WordAlignerStatus
        status={{ ok: false, opt_in: true, size: "~360 MB" }}
        alignment={{
          enabled: false,
          model: null,
          requested: null,
          installed: false,
          blocked: false,
          reason:
            "unavailable: word aligner 'onnx-base' is not downloaded (podcast bootstrap --component word-aligner)",
        }}
        disabled={false}
        retiming={false}
        onDownloaded={vi.fn()}
        onRetime={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Precise word boundaries unavailable: word aligner 'onnx-base' is not downloaded (podcast bootstrap --component word-aligner).",
    );
    expect(
      screen.getByRole("button", { name: "Download word aligner" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Re-time words" }),
    ).not.toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("offers Re-time words when the aligner is downloaded and the field is on by default", async () => {
    const onRetime = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <WordAlignerStatus
        status={{ ok: true, opt_in: true, size: "~360 MB" }}
        alignment={{
          enabled: true,
          model: "onnx-base",
          requested: null,
          installed: true,
          blocked: false,
          reason: "on by default: word aligner 'onnx-base' is installed",
        }}
        disabled={false}
        retiming={false}
        onDownloaded={vi.fn()}
        onRetime={onRetime}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Word aligner is downloaded (~360 MB). Precise word boundaries on by default: word aligner 'onnx-base' is installed.",
    );
    await user.click(screen.getByRole("button", { name: "Re-time words" }));
    expect(onRetime).toHaveBeenCalledTimes(1);
    await expectNoA11yViolations(container);
  });

  it("hides Re-time words when the field is explicitly off", () => {
    render(
      <WordAlignerStatus
        status={{ ok: true, opt_in: true, size: "~360 MB" }}
        alignment={{
          enabled: false,
          model: null,
          requested: false,
          installed: true,
          blocked: false,
          reason: "off: transcribe.forced_alignment.enabled is false",
        }}
        disabled={false}
        retiming={false}
        onDownloaded={vi.fn()}
        onRetime={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Precise word boundaries off: transcribe.forced_alignment.enabled is false.",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("has no axe violations when needing download", async () => {
    const { container } = render(
      <WordAlignerStatus
        status={{ ok: false, opt_in: true, size: "~360 MB" }}
        disabled={false}
        retiming={false}
        onDownloaded={vi.fn()}
        onRetime={vi.fn()}
      />,
    );
    await expectNoA11yViolations(container);
  });

  it("has no axe violations when downloaded", async () => {
    const { container } = render(
      <WordAlignerStatus
        status={{ ok: true, opt_in: true, size: "~360 MB" }}
        disabled={false}
        retiming={false}
        onDownloaded={vi.fn()}
        onRetime={vi.fn()}
      />,
    );
    await expectNoA11yViolations(container);
  });

  it("shows Re-timing… with aria-busy while retiming", async () => {
    const { container } = render(
      <WordAlignerStatus
        status={{ ok: true, opt_in: true, size: "~360 MB" }}
        disabled={true}
        retiming={true}
        onDownloaded={vi.fn()}
        onRetime={vi.fn()}
      />,
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
