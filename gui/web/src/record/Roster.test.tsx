import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { Roster } from "./Roster";
import type { RecordParticipant } from "./types";

const people: RecordParticipant[] = [
  {
    participant_id: "p_host",
    role: "host",
    display_name: "Host",
    connected: true,
    consented: true,
    muted: false,
    headphones_ack: true,
  },
  {
    participant_id: "p_g",
    role: "guest",
    display_name: "Ava",
    connected: true,
    consented: true,
    muted: true,
    headphones_ack: true,
  },
  {
    participant_id: "p_p",
    role: "producer",
    display_name: "Pat",
    connected: true,
    consented: null,
    muted: false,
    headphones_ack: false,
  },
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
});
