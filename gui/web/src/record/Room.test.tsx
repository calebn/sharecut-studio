import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
        hearing
      />,
    );
    expect(screen.getByText(HOST_OFFLINE_COPY)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Live comments" }),
    ).toBeInTheDocument();
    expect(screen.getByText(LOCAL_KEEPER_COPY)).toBeInTheDocument();
    expect(screen.queryByText(HEARING_COPY)).not.toBeInTheDocument();
    expect(screen.getByText("keeper failed")).toBeInTheDocument();
    await expectNoA11yViolations(container);
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
          uploading: true,
          pending: false,
          error: null,
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Leave" })).toBeDisabled();
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
          uploading: false,
          pending: false,
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
          uploading: false,
          pending: false,
          error: "upload failed",
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Leave" })).toBeEnabled();
  });
});
