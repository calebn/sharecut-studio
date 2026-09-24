import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import { LiveComments } from "./LiveComments";

const me = recordParticipant({
  participant_id: "p_g",
  display_name: "Ava",
});

const snapshot = recordSnapshot({
  session_id: "room1",
  recording_ms: 1000,
  participants: [me],
  comments: [
    {
      id: "c1",
      take_index: 0,
      recording_ms: 400,
      pressed_wall_ms: 400,
      author: "p_g",
      body: "Marker",
    },
  ],
});

describe("LiveComments", () => {
  it("posts a marker and a typed note", async () => {
    const user = userEvent.setup();
    const onMarker = vi.fn();
    const onNote = vi.fn();
    const onSubmitNote = vi.fn();
    const { container } = render(
      <LiveComments
        snapshot={snapshot}
        me={me}
        note="tighten this"
        onNote={onNote}
        onMarker={onMarker}
        onSubmitNote={onSubmitNote}
      />,
    );
    expect(screen.getByText("You: Marker")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Marker" }));
    expect(onMarker).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Add note" }));
    expect(onSubmitNote).toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("disables marker and notes outside an open take", () => {
    render(
      <LiveComments
        snapshot={{ ...snapshot, state: "lobby" }}
        me={me}
        note="hi"
        onNote={() => undefined}
        onMarker={() => undefined}
        onSubmitNote={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "Marker" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add note" })).toBeDisabled();
    expect(screen.getByLabelText("Note")).toBeDisabled();
  });
});
