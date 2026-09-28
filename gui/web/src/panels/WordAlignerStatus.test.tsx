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
        onDownloaded={vi.fn()}
        onRetime={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Re-time words" }),
    ).toBeDisabled();
  });

  it("has no axe violations when needing download", async () => {
    const { container } = render(
      <WordAlignerStatus
        status={{ ok: false, opt_in: true, size: "~360 MB" }}
        disabled={false}
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
        onDownloaded={vi.fn()}
        onRetime={vi.fn()}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
