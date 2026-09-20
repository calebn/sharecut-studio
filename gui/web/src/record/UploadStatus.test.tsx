import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
          uploading: true,
          pending: false,
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
          uploading: false,
          pending: false,
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
          uploading: false,
          pending: true,
          error: null,
        }}
      />,
    );
    expect(screen.queryByText(UPLOAD_COPY)).toBeNull();
    expect(container.textContent).toBe("");
  });
});
