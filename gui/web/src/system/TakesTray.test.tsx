import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TakesTray } from "./TakesTray";
import type { TakeInput } from "./takesTrayModel";

const JON = { name: "Jon", colorIndex: 3 };
const MAYA = { name: "Maya Okafor", colorIndex: 0 };

const TAKES: TakeInput[] = [
  {
    id: "t1",
    number: 1,
    lengthSec: 600,
    people: [
      { person: MAYA, line: { kind: "saved" } },
      { person: JON, line: { kind: "saved" }, clipTimes: ["02:14"] },
    ],
  },
  {
    id: "t2",
    number: 2,
    lengthSec: 300,
    people: [
      { person: MAYA, line: { kind: "saved" } },
      { person: JON, line: { kind: "land-failed" } },
    ],
  },
];

describe("TakesTray", () => {
  it("says so when there are no takes", () => {
    render(<TakesTray takes={[]} />);
    expect(screen.getByText(/No takes yet/)).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("lists one row per take in a named list", () => {
    render(<TakesTray takes={TAKES} />);
    const list = screen.getByRole("list", { name: "Takes" });
    expect(within(list).getByText("Take 1")).toBeInTheDocument();
    expect(within(list).getByText("Take 2")).toBeInTheDocument();
  });

  it("expands a take to its per-person lines and collapses it again", async () => {
    render(<TakesTray takes={TAKES} />);
    expect(screen.queryByText("Saved · Clipped 1 time · 02:14")).toBeNull();
    const toggle = screen.getByRole("button", { name: /Take 1/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText("Saved · Clipped 1 time · 02:14"),
    ).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.queryByText("Saved · Clipped 1 time · 02:14")).toBeNull();
  });

  it("starts with the named takes expanded", () => {
    render(<TakesTray takes={TAKES} defaultExpanded={["t2"]} />);
    expect(
      screen.getByText("Couldn't add to the timeline"),
    ).toBeInTheDocument();
  });

  it("offers Hear for a landed take and Retry for a failed line", async () => {
    const onHear = vi.fn();
    const onRetry = vi.fn();
    render(
      <TakesTray
        takes={TAKES}
        defaultExpanded={["t2"]}
        onHear={onHear}
        onRetry={onRetry}
      />,
    );
    expect(screen.getAllByRole("button", { name: /^Hear/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Hear Take 1" }));
    expect(onHear).toHaveBeenCalledWith("t1");
    await userEvent.click(
      screen.getByRole("button", { name: "Retry Jon, Take 2" }),
    );
    expect(onRetry).toHaveBeenCalledWith("t2", "Jon");
  });

  it("shows no actions without handlers", () => {
    render(<TakesTray takes={TAKES} defaultExpanded={["t2"]} />);
    expect(screen.queryByRole("button", { name: /^Hear|^Retry/ })).toBeNull();
  });
});
