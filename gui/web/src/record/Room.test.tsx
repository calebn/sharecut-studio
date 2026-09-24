import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import { Room } from "./Room";
import { HEARING_COPY, HOST_OFFLINE_COPY, LOCAL_KEEPER_COPY } from "./types";

const me = recordParticipant({
  participant_id: "p_g",
  display_name: "Ava",
});

const snapshot = recordSnapshot({
  session_id: "room1",
  recording_ms: 1000,
  participants: [me],
});

describe("Room", () => {
  it("shows local keeper and host-offline copy while recording", async () => {
    const retry = vi.fn();
    const { container } = render(
      <Room
        snapshot={snapshot}
        me={me}
        onMute={() => undefined}
        onLeave={() => undefined}
        onMarker={() => undefined}
        onSubmitNote={() => undefined}
        note=""
        onNote={() => undefined}
        connected={false}
        recordingLocally
        keeperError="keeper failed"
        onRetryKeeper={retry}
        hearing
      />,
    );
    expect(screen.getByText(HOST_OFFLINE_COPY)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Live comments" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(LOCAL_KEEPER_COPY)).not.toBeInTheDocument();
    expect(screen.getByText("REC: local capture failed")).toBeInTheDocument();
    expect(screen.queryByText(HEARING_COPY)).not.toBeInTheDocument();
    expect(screen.getByText(/keeper failed/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry local recording" }),
    );
    expect(retry).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("waits for the host to resume before offering local capture retry", async () => {
    const retry = vi.fn();
    const { container } = render(
      <Room
        snapshot={{ ...snapshot, state: "paused" }}
        me={me}
        onMute={() => undefined}
        onLeave={() => undefined}
        keeperError="storage failed"
        onRetryKeeper={retry}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Retry local recording" }),
    ).toBeDisabled();
    expect(screen.getByText(/ask the host to resume/i)).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("does not confuse upload storage with local capture failure", () => {
    render(
      <Room
        snapshot={snapshot}
        me={me}
        onMute={() => undefined}
        onLeave={() => undefined}
        recordingLocally
        uploadSinkError="Upload storage unavailable"
      />,
    );
    expect(screen.getByText("REC")).toBeInTheDocument();
    expect(screen.getByText(LOCAL_KEEPER_COPY)).toBeInTheDocument();
    expect(screen.getByText("Upload storage unavailable")).toBeInTheDocument();
    expect(
      screen.queryByText(/local recording stopped/i),
    ).not.toBeInTheDocument();
  });

  it("blocks Leave until the stopped take is file-ACK'd", () => {
    render(
      <Room
        snapshot={{ ...snapshot, state: "stopped" }}
        me={me}
        onMute={() => undefined}
        onLeave={() => undefined}
        upload={{
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
    expect(screen.getByRole("button", { name: "Leave" })).toBeDisabled();
  });

  it("offers microphone reconnect while local capture is lost", async () => {
    const retry = vi.fn();
    render(
      <Room
        snapshot={snapshot}
        me={me}
        onMute={() => undefined}
        onLeave={() => undefined}
        micLost
        onRetryMic={retry}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Reconnect microphone" }),
    );
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent(
      "REC: local capture failed",
    );
    expect(document.querySelector(".record-rec-dot")).toBeNull();
  });

  it("shows retry acquisition and recovery without changing the room clock", () => {
    const props = {
      snapshot,
      me,
      onMute: () => undefined,
      onLeave: () => undefined,
    };
    const { rerender } = render(<Room {...props} micLost />);
    expect(screen.getByRole("status")).toHaveTextContent("0:01");
    rerender(<Room {...props} micLost micPending />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "REC: waiting for microphone",
    );
    expect(screen.getByRole("status")).toHaveTextContent("0:01");
    rerender(<Room {...props} micLost />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "REC: local capture failed",
    );
    rerender(<Room {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent("REC0:01");
    expect(document.querySelector(".record-rec-dot")).not.toBeNull();
  });

  it("clears mic loss after Stop but preserves keeper recovery", () => {
    render(
      <Room
        snapshot={{ ...snapshot, state: "stopped" }}
        me={me}
        onMute={() => undefined}
        onLeave={() => undefined}
        micLost
        keeperError="incomplete keeper"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Stopped");
    expect(screen.queryByText(/Microphone disconnected/)).toBeNull();
    expect(screen.getByText(/incomplete keeper/)).toBeInTheDocument();
  });

  it("does not claim healthy REC when permission revocation clears the stream without a lost flag", () => {
    const retry = vi.fn();
    const props = {
      snapshot,
      me,
      onMute: () => undefined,
      onLeave: () => undefined,
      onRetryMic: retry,
    };
    const { rerender } = render(<Room {...props} micReady={false} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "REC: local capture failed",
    );
    expect(document.querySelector(".record-rec-dot")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Reconnect microphone" }),
    ).toBeInTheDocument();
    rerender(<Room {...props} micReady={false} micPending />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "REC: waiting for microphone",
    );
    rerender(<Room {...props} micReady />);
    expect(screen.getByRole("status")).toHaveTextContent("REC");
    expect(document.querySelector(".record-rec-dot")).not.toBeNull();
  });

  it("keeps a listening producer out of local microphone failure", () => {
    render(
      <Room
        snapshot={snapshot}
        me={{ ...me, role: "producer" }}
        onMute={() => undefined}
        onLeave={() => undefined}
        micReady
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("REC");
    expect(screen.queryByText(/Microphone disconnected/)).toBeNull();
  });

  it("re-enables Leave after file ACK or upload error", () => {
    const { rerender } = render(
      <Room
        snapshot={{ ...snapshot, state: "stopped" }}
        me={me}
        onMute={() => undefined}
        onLeave={() => undefined}
        upload={{
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
    expect(screen.getByRole("button", { name: "Leave" })).toBeEnabled();
    rerender(
      <Room
        snapshot={{ ...snapshot, state: "stopped" }}
        me={me}
        onMute={() => undefined}
        onLeave={() => undefined}
        upload={{
          acked: 1,
          total: 3,
          fileAck: false,
          landed: false,
          landFailed: false,
          reclaimFailed: false,
          uploading: false,
          pending: false,
          recoverable: false,
          error: "upload failed",
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Leave" })).toBeEnabled();
  });
});
