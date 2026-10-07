import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { recordParticipant } from "../test/fixtures";
import { HostUploadRoster } from "./HostUploadRoster";
import type { SegmentAckRow } from "./saveStatus";

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

function row(overrides: Partial<SegmentAckRow> = {}): SegmentAckRow {
  return {
    participant_id: "p_g",
    take_index: 0,
    segment_index: 0,
    acked_parts: [],
    ...overrides,
  };
}

const LIST = "Full-quality recording status";

describe("HostUploadRoster", () => {
  it("never lists a producer, even after Stop", () => {
    render(
      <HostUploadRoster
        stopped
        participants={[host, guest, producer]}
        segments={[]}
      />,
    );
    const list = screen.getByRole("list", { name: LIST });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).queryByText(/Pat/)).toBeNull();
  });

  it("renders nothing while recording when no participant has saved anything", () => {
    const { container } = render(
      <HostUploadRoster
        stopped={false}
        participants={[host, guest]}
        segments={[]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("list", { name: LIST })).toBeNull();
  });

  it("lists waiting participants as saving after Stop even with no segments", () => {
    render(
      <HostUploadRoster stopped participants={[host, guest]} segments={[]} />,
    );
    expect(screen.getByText("Ava: Saving to project…")).toBeInTheDocument();
    expect(screen.getByText("Host: Saving to project…")).toBeInTheDocument();
  });

  it("renders while recording once a participant has a segment in flight", () => {
    render(
      <HostUploadRoster
        stopped={false}
        participants={[host, guest]}
        segments={[row({ acked_parts: [0], expected_parts: 3 })]}
      />,
    );
    expect(
      screen.getByText("Ava: Saving to project… 1 of 3 chunks"),
    ).toBeInTheDocument();
    expect(screen.getByText("Host: Saving to project…")).toBeInTheDocument();
  });

  it("shows each participant's state after Stop", async () => {
    const { container } = render(
      <HostUploadRoster
        stopped
        participants={[host, guest]}
        segments={[
          row({ acked_parts: [0, 1], file_ack: true }),
          row({ participant_id: "p_host", acked_parts: [0] }),
        ]}
      />,
    );
    expect(screen.getByText("Ava: Saved to project")).toBeInTheDocument();
    expect(screen.getByText("Host: Saving to project…")).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("gives each segment of a participant its own state", () => {
    render(
      <HostUploadRoster
        stopped
        participants={[guest]}
        segments={[
          row({ acked_parts: [0, 1], file_ack: true }),
          row({ segment_index: 1, acked_parts: [0] }),
        ]}
      />,
    );
    expect(
      screen.getByText("Ava, take 1 segment 1: Saved to project"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Ava, take 1 segment 2: Saving to project…"),
    ).toBeInTheDocument();
  });

  it("keeps a failed landing visible beside the saved state", async () => {
    const { container } = render(
      <HostUploadRoster
        stopped
        participants={[guest]}
        segments={[
          row({ acked_parts: [0, 1], file_ack: true, land_failed: true }),
        ]}
      />,
    );
    expect(
      screen.getByText(
        "Ava: Saved to project. Landing failed. Use Retry land.",
      ),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });
});
