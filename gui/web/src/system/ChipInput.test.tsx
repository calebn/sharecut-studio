import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChipInput, type ChipInputProps } from "./ChipInput";

function Harness(
  props: Partial<ChipInputProps> & { onChange?: (t: string[]) => void },
) {
  const [terms, setTerms] = useState<string[]>([...(props.terms ?? [])]);
  return (
    <ChipInput
      speakers={props.speakers ?? ["Anneke"]}
      reservedChars={props.reservedChars}
      terms={terms}
      onTermsChange={(next) => {
        setTerms(next);
        props.onChange?.(next);
      }}
    />
  );
}

const field = () => screen.getByLabelText("Names and terms");
const live = () => screen.getByRole("status");
const removes = () => screen.queryAllByRole("button", { name: /^Remove/ });

describe("ChipInput", () => {
  it("lists speakers first, fixed, with the role in their name", () => {
    render(<Harness terms={["Utrecht"]} />);
    expect(
      screen.getByRole("listitem", { name: "Anneke, speaker" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /Anneke/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Remove Utrecht" }),
    ).toBeVisible();
  });

  it("adds on Enter and on a comma, and keeps the caret in the field", async () => {
    render(<Harness />);
    await userEvent.type(field(), "Okafor{Enter}");
    await userEvent.type(field(), "Utrecht,");
    expect(removes().map((b) => b.getAttribute("aria-label"))).toEqual([
      "Remove Okafor",
      "Remove Utrecht",
    ]);
    expect(field()).toHaveValue("");
    expect(field()).toHaveFocus();
  });

  it("does nothing on an empty Enter and does not swallow the key", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const notPrevented = fireEvent.keyDown(field(), { key: "Enter" });
    expect(notPrevented).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("prevents the default only when a chip is added", () => {
    render(<Harness />);
    fireEvent.change(field(), { target: { value: "Okafor" } });
    expect(fireEvent.keyDown(field(), { key: "Enter" })).toBe(false);
    fireEvent.change(field(), { target: { value: "okafor" } });
    expect(fireEvent.keyDown(field(), { key: "Enter" })).toBe(true);
  });

  it("ignores Enter during IME composition and with Mod or Shift", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(field(), { target: { value: "Okafor" } });
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(field(), { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(field(), { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(field()).toHaveValue("Okafor");
  });

  it("removes the last term on Backspace in an empty field only", async () => {
    render(<Harness terms={["Okafor", "Utrecht"]} />);
    await userEvent.type(field(), "x");
    await userEvent.keyboard("{Backspace}");
    expect(removes()).toHaveLength(2);
    await userEvent.keyboard("{Backspace}");
    expect(removes().map((b) => b.getAttribute("aria-label"))).toEqual([
      "Remove Okafor",
    ]);
    await userEvent.keyboard("{Backspace}{Backspace}");
    expect(removes()).toHaveLength(0);
    expect(
      screen.getByRole("listitem", { name: "Anneke, speaker" }),
    ).toBeVisible();
  });

  it("removes a term from its button", async () => {
    render(<Harness terms={["Okafor", "Utrecht"]} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Okafor" }),
    );
    expect(removes()).toHaveLength(1);
    expect(field()).toHaveFocus();
  });

  it("splits a paste with commas", async () => {
    render(<Harness />);
    await userEvent.click(field());
    await userEvent.paste("Okafor, Utrecht,, Rotterdam");
    expect(removes()).toHaveLength(3);
    expect(field()).toHaveValue("");
  });

  it("leaves a paste without commas alone", async () => {
    render(<Harness />);
    await userEvent.click(field());
    await userEvent.paste("Okafor");
    expect(field()).toHaveValue("Okafor");
  });

  it("dedupes without regard to case, against speakers too, and says so", async () => {
    render(<Harness terms={["Okafor"]} />);
    await userEvent.type(field(), "OKAFOR{Enter}");
    expect(removes()).toHaveLength(1);
    expect(
      screen.getAllByText("OKAFOR is already there.").length,
    ).toBeGreaterThan(0);
    expect(live()).toHaveTextContent("OKAFOR is already there.");
    await userEvent.clear(field());
    await userEvent.type(field(), "anneke{Enter}");
    expect(removes()).toHaveLength(1);
  });

  it("shows how many are left only within 40, and announces at the thresholds", async () => {
    // 372 budget. "Anneke" 6; "a"x300 -> 6+2+300=308; 64 left.
    render(<Harness terms={["a".repeat(300)]} />);
    expect(screen.queryByText(/left$/)).toBeNull();
    await userEvent.type(field(), "b".repeat(30));
    await userEvent.keyboard("{Enter}");
    // 308 + 2 + 30 = 340; 32 left
    expect(screen.getByText("32 left")).toBeVisible();
    expect(live()).toHaveTextContent("32 characters left");
    await userEvent.type(field(), "c".repeat(30));
    await userEvent.keyboard("{Enter}");
    // 372 exactly: 0 left
    expect(screen.getByText("0 left")).toBeVisible();
    expect(live()).toHaveTextContent("No characters left");
  });

  it("stays typeable at the limit and refuses the add in words", async () => {
    render(
      <Harness
        terms={[
          "a".repeat(100),
          "b".repeat(100),
          "c".repeat(100),
          "d".repeat(54),
        ]}
      />,
    );
    // 6 + 2 + 100 + 2 + 100 + 2 + 100 + 2 + 54 = 368; 4 left
    await userEvent.type(field(), "toolong{Enter}");
    expect(field()).toHaveValue("toolong");
    expect(
      screen.getAllByText("That is the limit. Remove a term to add more.")
        .length,
    ).toBeGreaterThan(0);
    expect(live()).toHaveTextContent(
      "That is the limit. Remove a term to add more.",
    );
    expect(removes()).toHaveLength(4);
  });

  it("counts the reserved characters against the budget", async () => {
    render(<Harness reservedChars={340} />);
    // budget 32, Anneke uses 6 -> 26 left, within 40
    expect(screen.getByText("26 left")).toBeVisible();
  });

  it("refuses an entry over 100 characters", async () => {
    render(<Harness />);
    await userEvent.type(field(), `${"x".repeat(101)}{Enter}`);
    expect(removes()).toHaveLength(0);
    expect(screen.getAllByText(/under 100 characters/).length).toBeGreaterThan(
      0,
    );
  });

  it("stops at 100 entries", async () => {
    const many = Array.from({ length: 99 }, (_, i) => String(i));
    // 99 one to two character terms stay under budget? 10*1 + 89*2 + 98*2... too big
    render(<Harness speakers={[]} terms={many.slice(0, 5)} />);
    await userEvent.type(field(), "ok{Enter}");
    expect(removes()).toHaveLength(6);
  });
});
