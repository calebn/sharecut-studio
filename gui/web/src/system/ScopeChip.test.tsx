import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ScopeChip } from "./ScopeChip";

const tracks = [
  { id: "a", name: "Mira", color: "var(--color-clip-dialogue-0)" },
  { id: "b", name: "Jonas", color: "var(--color-clip-dialogue-1)" },
  { id: "c", name: "Rae", color: "var(--color-clip-dialogue-2)" },
];

describe("ScopeChip", () => {
  it("draws one dot per track and names them", () => {
    const { container } = render(
      <ScopeChip tracks={tracks} all={false} ripple />,
    );
    expect(container.querySelectorAll(".sys-scope-dot")).toHaveLength(3);
    expect(screen.getByText("Mira, Jonas, Rae")).toBeInTheDocument();
  });

  it("says All instead of dots when the scope is every track", () => {
    const { container } = render(<ScopeChip tracks={tracks} all ripple />);
    expect(screen.getByText("All")).toBeInTheDocument();
    expect(container.querySelectorAll(".sys-scope-dot")).toHaveLength(0);
  });

  it("counts the tracks past three dots", () => {
    const more = [
      ...tracks,
      { id: "d", name: "Sam", color: "var(--color-clip-music)" },
    ];
    const { container } = render(
      <ScopeChip tracks={more} all={false} ripple />,
    );
    expect(container.querySelectorAll(".sys-scope-dot")).toHaveLength(3);
    expect(screen.getByText("+1")).toBeInTheDocument();
  });

  it("shows the ripple mark when time closes", () => {
    render(<ScopeChip tracks={tracks} all={false} ripple />);
    expect(screen.getByText("Ripple")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Leave gap" })).toBeNull();
  });

  it("shows the gap glyph when time is kept", () => {
    render(<ScopeChip tracks={tracks} all={false} ripple={false} />);
    expect(screen.getByRole("img", { name: "Leave gap" })).toBeInTheDocument();
    expect(screen.queryByText("Ripple")).toBeNull();
  });

  it("is a button only when it can toggle", async () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <ScopeChip tracks={tracks} all={false} ripple />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    rerender(
      <ScopeChip tracks={tracks} all={false} ripple onToggle={onToggle} />,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
