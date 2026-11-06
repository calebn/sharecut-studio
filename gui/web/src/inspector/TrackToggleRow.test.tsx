import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TrackToggleRow } from "./TrackToggleRow";

const TRACKS = [
  { id: "a", label: "reference" },
  { id: "b", label: "guest" },
];

describe("TrackToggleRow", () => {
  it("adds and removes a track from the scope", async () => {
    const onChange = vi.fn();
    render(
      <TrackToggleRow
        label="Scope"
        tracks={TRACKS}
        value={["a"]}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "guest" }));
    expect(onChange).toHaveBeenLastCalledWith(["a", "b"]);
  });

  it("refuses to switch the last track off", async () => {
    const onChange = vi.fn();
    render(
      <TrackToggleRow
        label="Scope"
        tracks={TRACKS}
        value={["a"]}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "reference" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does nothing while disabled", async () => {
    const onChange = vi.fn();
    render(
      <TrackToggleRow
        label="Scope"
        tracks={TRACKS}
        value={["a", "b"]}
        disabled
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "guest" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
