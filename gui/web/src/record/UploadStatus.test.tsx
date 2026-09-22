import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { UPLOAD_COPY, UPLOAD_DONE_COPY, uploadProgressCopy } from "./types";
import { UploadStatus } from "./UploadStatus";

describe("UploadStatus", () => {
  it("shows chunk progress until file ACK, then safe-to-delete copy", () => {
    const { rerender } = render(
      <UploadStatus
        stopped
        progress={{
          acked: 1,
          total: 3,
          fileAck: false,
          landed: false,
          landFailed: false,
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
          uploading: false,
          pending: false,
          recoverable: false,
          error: null,
        }}
      />,
    );
    expect(screen.getByText(UPLOAD_DONE_COPY)).toBeInTheDocument();
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
        onDownload={onDownload}
        progress={{
          acked: 1,
          total: 3,
          fileAck: false,
          landed: false,
          landFailed: false,
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
        onDownload={() => undefined}
        progress={{
          acked: 0,
          total: 0,
          fileAck: false,
          landed: false,
          landFailed: false,
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
      uploading: false,
      pending: false,
      recoverable: true,
      error: "A readable partial keeper was retained.",
    };
    const { container, rerender } = render(
      <UploadStatus stopped progress={progress} onRecover={onRecover} />,
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
        onRecover={onRecover}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Recover partial take" }),
    ).toBeNull();
    rerender(
      <UploadStatus
        stopped
        progress={{ ...progress, recoverable: false }}
        onRecover={onRecover}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Recover partial take" }),
    ).toBeNull();
  });
});
