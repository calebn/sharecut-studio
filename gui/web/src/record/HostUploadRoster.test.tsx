import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { HostUploadRoster } from "./HostUploadRoster";
import { hostUploadLine, type RecordParticipant } from "./types";

const host: RecordParticipant = {
  participant_id: "p_host",
  role: "host",
  display_name: "Host",
  connected: true,
  consented: true,
  muted: false,
  headphones_ack: true,
};

const guest: RecordParticipant = {
  participant_id: "p_g",
  role: "guest",
  display_name: "Ava",
  connected: true,
  consented: true,
  muted: false,
  headphones_ack: true,
};

describe("HostUploadRoster", () => {
  it("lists every recorded participant after Stop", async () => {
    const { container } = render(
      <HostUploadRoster
        stopped
        participants={[host, guest]}
        segments={[
          {
            participant_id: "p_g",
            acked_parts: [0, 1],
            file_ack: true,
          },
          {
            participant_id: "p_host",
            acked_parts: [0],
            file_ack: false,
          },
        ]}
      />,
    );
    expect(
      screen.getByText(hostUploadLine("Ava", true, 2)),
    ).toBeInTheDocument();
    expect(
      screen.getByText(hostUploadLine("Host", false, 1)),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("requires every segment for a participant before uploaded copy", () => {
    render(
      <HostUploadRoster
        stopped
        participants={[guest]}
        segments={[
          {
            participant_id: "p_g",
            acked_parts: [0, 1],
            file_ack: true,
          },
          {
            participant_id: "p_g",
            acked_parts: [0],
            file_ack: false,
          },
        ]}
      />,
    );
    expect(
      screen.getByText(hostUploadLine("Ava", false, 3)),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(hostUploadLine("Ava", true, 3)),
    ).not.toBeInTheDocument();
  });

  it("reports land failure separately from upload acknowledgement", async () => {
    const { container } = render(
      <HostUploadRoster
        stopped
        participants={[guest]}
        segments={[
          {
            participant_id: "p_g",
            acked_parts: [0, 1],
            file_ack: true,
            landed: false,
            land_failed: true,
          },
        ]}
      />,
    );
    expect(screen.getByText(/landing failed/)).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });
});
