import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { recordParticipant } from "../test/fixtures";
import { Roster } from "./Roster";

const people = [
  recordParticipant({
    participant_id: "p_host",
    role: "host",
    display_name: "Host",
  }),
  recordParticipant({
    participant_id: "p_g",
    display_name: "Ava",
    muted: true,
  }),
  recordParticipant({
    participant_id: "p_p",
    role: "producer",
    display_name: "Pat",
    consented: null,
    headphones_ack: false,
  }),
];

describe("Roster", () => {
  it("groups producers under Not recorded", async () => {
    const { container } = render(<Roster participants={people} />);
    expect(
      screen.getByRole("heading", { name: "Recording" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Not recorded" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Ava · consented · muted/)).toBeInTheDocument();
    expect(screen.getByText("Pat")).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("announces join and leave in the live region", () => {
    const withoutAva = people.filter((p) => p.participant_id !== "p_g");
    const { rerender } = render(<Roster participants={withoutAva} />);
    rerender(<Roster participants={people} />);
    expect(screen.getByText("Ava joined")).toBeInTheDocument();
    rerender(<Roster participants={withoutAva} />);
    expect(screen.getByText("Ava left")).toBeInTheDocument();
  });
  it("announces a join after the room empties", () => {
    const { container, rerender } = render(<Roster participants={people} />);
    const announcement = container.querySelector('[aria-live="polite"]');
    expect(announcement).toHaveTextContent("");
    rerender(<Roster participants={[]} />);
    expect(announcement).toHaveTextContent("Host left. Ava left. Pat left");
    rerender(
      <Roster participants={[recordParticipant({ display_name: "Dee" })]} />,
    );
    expect(announcement).toHaveTextContent("Dee joined");
  });

  it("announces every join and leave in a single snapshot", () => {
    const { container, rerender } = render(<Roster participants={people} />);
    const announcement = container.querySelector('[aria-live="polite"]');
    rerender(
      <Roster
        participants={[
          recordParticipant({ participant_id: "guest-d", display_name: "Dee" }),
          recordParticipant({ participant_id: "guest-e", display_name: "Eli" }),
        ]}
      />,
    );
    expect(announcement).toHaveTextContent(
      "Dee joined. Eli joined. Host left. Ava left. Pat left",
    );
  });
});
