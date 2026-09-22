import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { Room } from "./Room";
import type { RecordParticipant, RecordSnapshot } from "./types";
import { HEARING_COPY, HOST_OFFLINE_COPY, LOCAL_KEEPER_COPY } from "./types";

const me: RecordParticipant = {
  participant_id: "p_g",
  role: "guest",
  display_name: "Ava",
  connected: true,
  consented: true,
  muted: false,
  headphones_ack: true,
};

const snapshot: RecordSnapshot = {
  session_id: "room1",
  state: "recording",
  take_index: 0,
  recording_ms: 1000,
  participants: [me],
  caps: { recorded: 4, producers: 2 },
};

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
    expect(screen.getByText("REC — local capture failed")).toBeInTheDocument();
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
