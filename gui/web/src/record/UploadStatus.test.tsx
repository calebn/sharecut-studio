import { fireEvent, render, screen } from "@testing-library/react";
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
          error: null,
        }}
      />,
    );
    expect(screen.getByText(KEEPER_RECLAIM_MISMATCH_COPY)).toBeInTheDocument();
    expect(screen.queryByText(UPLOAD_DONE_COPY)).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Download local keeper" }),
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
          error: "Upload failed",
        }}
      />,
    );
    expect(screen.getByText("Upload failed")).toBeInTheDocument();
    expect(screen.getByText(KEEPER_RECLAIM_MISMATCH_COPY)).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Resume upload" }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "Download local keeper" }),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Resume upload" }));
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
          error: null,
        }}
      />,
    );
    expect(screen.getByText(uploadProgressCopy(1, 2))).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Resume upload" }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "Download local keeper" }),
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
          error: null,
        }}
      />,
    );
    expect(screen.getByText(/not landed on the host/)).toBeInTheDocument();
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
          error: null,
        }}
      />,
    );
    expect(screen.getByText(/not landed on the host/)).toBeInTheDocument();
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
          error: null,
        }}
      />,
    );
    expect(screen.getByText(/waiting to land on the host/)).toBeInTheDocument();
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
          error: null,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume upload" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Download local keeper" }),
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
          error: "No audio was captured for this take.",
        }}
      />,
    );
    expect(screen.getByText(/No audio was captured/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Resume upload" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download local keeper" }),
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
});
