import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { recordParticipant } from "../test/fixtures";
import { HostUploadRoster } from "./HostUploadRoster";
import { hostUploadLine } from "./types";

const host = recordParticipant({
  participant_id: "p_host",
  role: "host",
  display_name: "Host",
});

const guest = recordParticipant({ participant_id: "p_g", display_name: "Ava" });

const producer = recordParticipant({
  participant_id: "p_pat",
  role: "producer",
  display_name: "Pat",
});

describe("HostUploadRoster", () => {
  it("never lists a producer, even after Stop", () => {
    render(
      <HostUploadRoster
        stopped
        participants={[host, guest, producer]}
        segments={[]}
      />,
    );
    const list = screen.getByRole("list", { name: "Upload status" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).queryByText(/Pat/)).toBeNull();
  });

  it("renders nothing while recording when no participant has uploaded", () => {
    const { container } = render(
      <HostUploadRoster
        stopped={false}
        participants={[host, guest]}
        segments={[]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("list", { name: "Upload status" })).toBeNull();
  });

  it("lists waiting participants after Stop even with no segments", () => {
    render(
      <HostUploadRoster stopped participants={[host, guest]} segments={[]} />,
    );
    expect(
      screen.getByText(hostUploadLine("Ava", false, 0)),
    ).toBeInTheDocument();
    expect(
      screen.getByText(hostUploadLine("Host", false, 0)),
    ).toBeInTheDocument();
  });

  it("renders while recording once a participant has an acked segment", () => {
    render(
      <HostUploadRoster
        stopped={false}
        participants={[host, guest]}
        segments={[
          {
            participant_id: "p_g",
            acked_parts: [0],
            file_ack: false,
          },
        ]}
      />,
    );
    expect(
      screen.getByText(hostUploadLine("Ava", false, 1)),
    ).toBeInTheDocument();
    expect(
      screen.getByText(hostUploadLine("Host", false, 0)),
    ).toBeInTheDocument();
  });

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

  it("reports declared chunk totals and includes assembled segments", () => {
    const { rerender } = render(
      <HostUploadRoster
        stopped
        participants={[guest]}
        segments={[
          {
            participant_id: "p_g",
            acked_parts: [0],
            expected_parts: 3,
            file_ack: false,
          },
        ]}
      />,
    );
    expect(screen.getByText("Ava: 1/3 chunks acked.")).toBeInTheDocument();
    rerender(
      <HostUploadRoster
        stopped
        participants={[guest]}
        segments={[
          {
            participant_id: "p_g",
            acked_parts: [],
            expected_parts: 2,
            file_ack: true,
          },
          {
            participant_id: "p_g",
            acked_parts: [0],
            expected_parts: 3,
            file_ack: false,
          },
        ]}
      />,
    );
    expect(screen.getByText("Ava: 3/5 chunks acked.")).toBeInTheDocument();
  });

  it("does not show a partial total when another segment has no declared size", () => {
    render(
      <HostUploadRoster
        stopped
        participants={[guest]}
        segments={[
          {
            participant_id: "p_g",
            acked_parts: [0],
            expected_parts: 3,
            file_ack: false,
          },
          {
            participant_id: "p_g",
            acked_parts: [],
            file_ack: false,
          },
        ]}
      />,
    );
    expect(screen.getByText("Ava: 1 chunk acked.")).toBeInTheDocument();
    expect(screen.queryByText("Ava: 1/3 chunks acked.")).toBeNull();
  });

  it("renders nothing while recording before any segment arrives", () => {
    const { container } = render(
      <HostUploadRoster
        participants={[host, guest]}
        segments={[]}
        stopped={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lists waiting participants after Stop even with no segments", () => {
    render(
      <HostUploadRoster participants={[host, guest]} segments={[]} stopped />,
    );
    expect(
      screen.getByText(hostUploadLine("Ava", false, 0)),
    ).toBeInTheDocument();
  });
});
