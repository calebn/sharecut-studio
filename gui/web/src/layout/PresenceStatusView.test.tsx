import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { sessionClient } from "../test/fixtures";
import { PresenceStatusView } from "./PresenceStatusView";

describe("PresenceStatusView", () => {
  it("renders nothing for an empty roster", () => {
    const { container } = render(
      <PresenceStatusView narrow={false} clients={[]} localClientId={null} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("titles each client by display name, then label, then client id", () => {
    render(
      <PresenceStatusView
        narrow={false}
        clients={[
          sessionClient({
            client_id: "a",
            role: "guest",
            meta: { display_name: "Ada", color_index: 0 },
          }),
          sessionClient({
            client_id: "b",
            role: "host",
            label: "Bob",
            meta: null,
          }),
          sessionClient({ client_id: "c-id", role: "agent", meta: null }),
        ]}
        localClientId={null}
      />,
    );
    const chip = screen.getByText(/^Presence: You/);
    expect(chip.getAttribute("title")).toBe(
      "Ada (guest), Bob (host), c-id (agent)",
    );
    expect(chip.className).toBe("");
  });

  it("adds the status-bar-secondary class when narrow", () => {
    render(
      <PresenceStatusView
        narrow
        clients={[sessionClient()]}
        localClientId={null}
      />,
    );
    expect(screen.getByText(/^Presence: You/).className).toBe(
      "status-bar-secondary",
    );
  });
});
