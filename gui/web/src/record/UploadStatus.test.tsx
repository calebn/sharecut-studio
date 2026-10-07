import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import {
  KEEPER_RECLAIM_FAILED_COPY,
  KEEPER_RECLAIM_MISMATCH_COPY,
  UPLOAD_COPY,
  UPLOAD_DONE_COPY,
  uploadProgressCopy,
} from "./types";
import { UploadStatus } from "./UploadStatus";
import type { KeeperRecoveryActions } from "./upload/useKeeperRecoveryActions";

function keeperActions(
  overrides: Partial<KeeperRecoveryActions> = {},
): KeeperRecoveryActions {
  return { busy: false, error: null, notice: null, ...overrides };
}

describe("UploadStatus", () => {
  it("warns and offers a download when landed bytes do not match", async () => {
    const download = vi.fn();
    const { container } = render(
      <UploadStatus
        stopped
        actions={keeperActions({ download })}
        progress={{
          acked: 1,
          total: 1,
          fileAck: true,
          landed: true,
          landFailed: false,
          reclaimFailed: false,
          reclaimMismatch: true,
          uploading: false,
          pending: false,
          recoverable: false,
          segments: [],
          error: null,
        }}
      />,
    );
    expect(screen.getByText(KEEPER_RECLAIM_MISMATCH_COPY)).toBeInTheDocument();
    expect(screen.queryByText(UPLOAD_DONE_COPY)).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Download full-quality recording" }),
    );
    expect(download).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("renders recovery actions once when upload error and mismatch overlap", async () => {
    const onResume = vi.fn();
    const download = vi.fn();
    const { container } = render(
      <UploadStatus
        stopped
        onResume={onResume}
        actions={keeperActions({ download })}
        progress={{
          acked: 1,
          total: 2,
          fileAck: false,
          landed: false,
          landFailed: false,
          reclaimFailed: false,
          reclaimMismatch: true,
          uploading: false,
          pending: false,
          recoverable: false,
          segments: [],
          error: "Upload failed",
        }}
      />,
    );
    expect(screen.getByText("Upload failed")).toBeInTheDocument();
    expect(screen.getByText(KEEPER_RECLAIM_MISMATCH_COPY)).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Resume saving" }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("button", {
        name: "Download full-quality recording",
      }),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Resume saving" }));
    expect(onResume).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("renders one action set while upload progress and mismatch overlap", () => {
    render(
      <UploadStatus
        stopped
        onResume={vi.fn()}
        actions={keeperActions({ download: vi.fn() })}
        progress={{
          acked: 1,
          total: 2,
          fileAck: false,
          landed: false,
          landFailed: false,
          reclaimFailed: false,
          reclaimMismatch: true,
          uploading: true,
          pending: false,
          recoverable: false,
          segments: [],
          error: null,
        }}
      />,
    );
    expect(screen.getByText(uploadProgressCopy(1, 2))).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Resume saving" }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("button", {
        name: "Download full-quality recording",
      }),
    ).toHaveLength(1);
  });

  it("shows upload failure and retained keeper warning together", () => {
    render(
      <UploadStatus
        stopped
        progress={{
          acked: 1,
          total: 2,
          fileAck: false,
          landed: false,
          landFailed: true,
          reclaimFailed: false,
          reclaimMismatch: true,
          uploading: false,
          pending: false,
          recoverable: false,
          segments: [],
          error: null,
        }}
      />,
    );
    expect(screen.getByText(/not on the timeline yet/)).toBeInTheDocument();
    expect(screen.getByText(KEEPER_RECLAIM_MISMATCH_COPY)).toBeInTheDocument();
  });

  it("shows chunk progress until file ACK, then landed copy", () => {
    const { rerender } = render(
      <UploadStatus
        stopped
        progress={{
          acked: 1,
          total: 3,
          fileAck: false,
          landed: false,
          landFailed: false,
          reclaimFailed: false,
          uploading: true,
          pending: false,
          recoverable: false,
          segments: [],
          error: null,
        }}
      />,
    );
    expect(screen.getByText(uploadProgressCopy(1, 3))).toBeInTheDocument();
    rerender(
      <UploadStatus
        stopped
        progress={{
          acked: 3,
          total: 3,
          fileAck: true,
          landed: true,
          landFailed: false,
          reclaimFailed: false,
          uploading: false,
          pending: false,
          recoverable: false,
          segments: [],
          error: null,
        }}
      />,
    );
    expect(screen.getByText(UPLOAD_DONE_COPY)).toBeInTheDocument();
  });

  it("warns when a landed keeper could not be cleared locally", async () => {
    const { container } = render(
      <UploadStatus
        stopped
        progress={{
          acked: 1,
          total: 1,
          fileAck: true,
          landed: true,
          landFailed: false,
          reclaimFailed: true,
          uploading: false,
          pending: false,
          recoverable: false,
          segments: [],
          error: null,
        }}
      />,
    );
    expect(screen.getByText(KEEPER_RECLAIM_FAILED_COPY)).toBeInTheDocument();
    expect(screen.queryByText(UPLOAD_DONE_COPY)).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("does not show upload copy before a take exists", () => {
    const { container } = render(
      <UploadStatus
        stopped={false}
        progress={{
          acked: 0,
          total: 0,
          fileAck: false,
          landed: false,
          landFailed: false,
          reclaimFailed: false,
          uploading: false,
          pending: true,
          recoverable: false,
          segments: [],
          error: null,
        }}
      />,
    );
    expect(screen.queryByText(UPLOAD_COPY)).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("keeps a failed landing visible without claiming the backup is safe", () => {
    render(
      <UploadStatus
        stopped
        progress={{
          acked: 3,
          total: 3,
          fileAck: true,
          landed: false,
          landFailed: true,
          reclaimFailed: false,
          uploading: false,
          pending: false,
          recoverable: false,
          segments: [],
          error: null,
        }}
      />,
    );
    expect(screen.getByText(/not on the timeline yet/)).toBeInTheDocument();
    expect(screen.queryByText(UPLOAD_DONE_COPY)).not.toBeInTheDocument();
  });

  it("keeps an uploaded backup until landing is confirmed", async () => {
    const { container } = render(
      <UploadStatus
        stopped
        progress={{
          acked: 3,
          total: 3,
          fileAck: true,
          landed: false,
          landFailed: false,
          reclaimFailed: false,
          uploading: false,
          pending: false,
          recoverable: false,
          segments: [],
          error: null,
        }}
      />,
    );
    expect(screen.getByText(/until the host lands it/)).toBeInTheDocument();
    expect(screen.queryByText(UPLOAD_DONE_COPY)).not.toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("offers accessible recovery actions for a stopped incomplete take", async () => {
    const onResume = vi.fn();
    const onDownload = vi.fn();
    const { container } = render(
      <UploadStatus
        stopped
        onResume={onResume}
        actions={keeperActions({ download: onDownload })}
        progress={{
          acked: 1,
          total: 3,
          fileAck: false,
          landed: false,
          landFailed: false,
          reclaimFailed: false,
          uploading: false,
          pending: false,
          recoverable: false,
          segments: [],
          error: null,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume saving" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Download full-quality recording" }),
    );
    expect(onResume).toHaveBeenCalledOnce();
    expect(onDownload).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("keeps recovery actions visible when no chunks were captured", () => {
    render(
      <UploadStatus
        stopped
        onResume={() => undefined}
        actions={keeperActions({ download: () => undefined })}
        progress={{
          acked: 0,
          total: 0,
          fileAck: false,
          landed: false,
          landFailed: false,
          reclaimFailed: false,
          uploading: false,
          pending: false,
          recoverable: false,
          segments: [],
          error: "No audio was captured for this take.",
        }}
      />,
    );
    expect(screen.getByText(/No audio was captured/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Resume saving" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download full-quality recording" }),
    ).toBeInTheDocument();
  });

  it("offers partial recovery only for a stopped, recoverable keeper", async () => {
    const onRecover = vi.fn();
    const progress = {
      acked: 0,
      total: 0,
      fileAck: false,
      landed: false,
      landFailed: false,
      reclaimFailed: false,
      uploading: false,
      pending: false,
      recoverable: true,
      segments: [],
      error: "A readable partial keeper was retained.",
    };
    const { container, rerender } = render(
      <UploadStatus
        stopped
        progress={progress}
        actions={keeperActions({ recover: onRecover })}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Recover partial take" }),
    );
    expect(onRecover).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
    rerender(
      <UploadStatus
        stopped={false}
        progress={progress}
        actions={keeperActions({ recover: onRecover })}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Recover partial take" }),
    ).toBeNull();
    rerender(
      <UploadStatus
        stopped
        progress={{ ...progress, recoverable: false }}
        actions={keeperActions({ recover: onRecover })}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Recover partial take" }),
    ).toBeNull();
  });

  it("marks recovery busy without removing the focused control", async () => {
    const recover = vi.fn();
    const progress = {
      acked: 0,
      total: 0,
      fileAck: false,
      landed: false,
      landFailed: false,
      reclaimFailed: false,
      uploading: false,
      pending: false,
      recoverable: true,
      segments: [],
      error: "A readable partial keeper was retained.",
    };
    const { container } = render(
      <UploadStatus
        stopped
        progress={progress}
        actions={keeperActions({ recover, busy: true })}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Recovering partial take…",
    });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    await expectNoA11yViolations(container);
  });

  it("announces keeper action results separately from upload state", async () => {
    const progress = {
      acked: 3,
      total: 3,
      fileAck: true,
      landed: true,
      landFailed: false,
      reclaimFailed: false,
      uploading: false,
      pending: false,
      recoverable: false,
      segments: [],
      error: null,
    };
    const { container, rerender } = render(
      <UploadStatus
        stopped
        progress={progress}
        actions={keeperActions({ notice: "Recovered 1 partial segment." })}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Recovered 1 partial segment.",
    );
    await expectNoA11yViolations(container);
    rerender(
      <UploadStatus
        stopped
        progress={progress}
        actions={keeperActions({ error: "incomplete PCM frame" })}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "incomplete PCM frame",
    );
  });

  describe("per-segment status", () => {
    const progress = {
      acked: 2,
      total: 4,
      fileAck: false,
      landed: false,
      landFailed: false,
      reclaimFailed: false,
      uploading: true,
      pending: false,
      recoverable: false,
      error: null,
    };

    it("lists each segment with Saved to project or Saving to project…", async () => {
      const { container } = render(
        <UploadStatus
          stopped
          progress={{
            ...progress,
            segments: [
              {
                take: 0,
                segment: 0,
                state: "saved",
                chunks: null,
                landFailed: false,
              },
              {
                take: 0,
                segment: 1,
                state: "saving",
                chunks: { acked: 1, total: 2 },
                landFailed: false,
              },
            ],
          }}
        />,
      );
      const list = screen.getByRole("list", {
        name: "Your full-quality recording status",
      });
      expect(
        within(list)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual([
        "Take 1 segment 1: Saved to project",
        "Take 1 segment 2: Saving to project… 1 of 2 chunks",
      ]);
      await expectNoA11yViolations(container);
    });

    it("omits the list when the host panel lists every participant itself", () => {
      render(
        <UploadStatus
          stopped
          segmentList={false}
          progress={{
            ...progress,
            segments: [
              {
                take: 0,
                segment: 0,
                state: "saved",
                chunks: null,
                landFailed: false,
              },
              {
                take: 0,
                segment: 1,
                state: "saving",
                chunks: { acked: 1, total: 2 },
                landFailed: false,
              },
            ],
          }}
        />,
      );
      expect(screen.queryByRole("list")).toBeNull();
      expect(screen.getByText(uploadProgressCopy(2, 4))).toBeInTheDocument();
    });

    it("leaves one segment to the status line instead of a one-item list", () => {
      render(
        <UploadStatus
          stopped
          progress={{
            ...progress,
            segments: [
              {
                take: 0,
                segment: 0,
                state: "saving",
                chunks: { acked: 2, total: 4 },
                landFailed: false,
              },
            ],
          }}
        />,
      );
      expect(screen.queryByRole("list")).toBeNull();
      expect(screen.getByText(uploadProgressCopy(2, 4))).toBeInTheDocument();
    });
  });

  describe("segment list while uploading", () => {
    const base = {
      fileAck: false,
      landed: false,
      landFailed: false,
      reclaimFailed: false,
      pending: false,
      recoverable: false,
      error: null,
    };
    const saving = (segment: number, acked: number) => ({
      take: 0,
      segment,
      state: "saving" as const,
      chunks: { acked, total: 3 },
      landFailed: false,
    });
    const saved = (segment: number) => ({
      take: 0,
      segment,
      state: "saved" as const,
      chunks: null,
      landFailed: false,
    });
    const region = (container: HTMLElement) =>
      container.querySelector('[aria-live="polite"]');

    it("lists each segment as it starts and announces only state changes", async () => {
      const { container, rerender } = render(
        <UploadStatus
          stopped
          progress={{
            ...base,
            acked: 0,
            total: 3,
            uploading: true,
            segments: [saving(0, 0)],
          }}
        />,
      );
      expect(screen.queryByRole("list")).toBeNull();
      expect(region(container)).toHaveTextContent("");

      rerender(
        <UploadStatus
          stopped
          progress={{
            ...base,
            acked: 3,
            total: 6,
            uploading: true,
            segments: [saved(0), saving(1, 0)],
          }}
        />,
      );
      const list = screen.getByRole("list", {
        name: "Your full-quality recording status",
      });
      expect(
        within(list)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual([
        "Take 1 segment 1: Saved to project",
        "Take 1 segment 2: Saving to project… 0 of 3 chunks",
      ]);
      expect(region(container)).toHaveTextContent(
        "Take 1 segment 2: Saving to project…",
      );
      const first = region(container)?.textContent;

      rerender(
        <UploadStatus
          stopped
          progress={{
            ...base,
            acked: 4,
            total: 6,
            uploading: true,
            segments: [saved(0), saving(1, 1)],
          }}
        />,
      );
      expect(
        screen.getByText("Take 1 segment 2: Saving to project… 1 of 3 chunks"),
      ).toBeInTheDocument();
      expect(region(container)?.textContent).toBe(first);

      rerender(
        <UploadStatus
          stopped
          progress={{
            ...base,
            acked: 6,
            total: 6,
            uploading: true,
            segments: [saved(0), saved(1)],
          }}
        />,
      );
      expect(region(container)).toHaveTextContent(
        "Take 1 segment 2: Saved to project",
      );
      await expectNoA11yViolations(container);
    });
  });
});
