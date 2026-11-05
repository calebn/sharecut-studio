import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StageHandoff } from "./StageHandoff";

afterEach(() => vi.unstubAllGlobals());

function setup(props: Partial<Parameters<typeof StageHandoff>[0]> = {}) {
  const onActivate = vi.fn();
  render(
    <StageHandoff
      stage="review"
      label="Review 14 suggestions"
      onActivate={onActivate}
      {...props}
    />,
  );
  return {
    onActivate,
    button: screen.getByRole("button", { name: "Review 14 suggestions" }),
  };
}

describe("StageHandoff", () => {
  it("is named by its label alone and runs on click", async () => {
    const { button, onActivate } = setup();
    expect(button).toHaveAccessibleName("Review 14 suggestions");
    await userEvent.click(button);
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it("hides the arrow and the key hint from assistive tech", () => {
    const { button } = setup();
    for (const icon of button.querySelectorAll("svg")) {
      expect(icon).toHaveAttribute("aria-hidden", "true");
    }
    expect(button.querySelector(".sys-keys")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("is secondary by default and primary on request", () => {
    expect(setup().button).not.toHaveClass("primary");
  });

  it("renders primary", () => {
    expect(setup({ variant: "primary" }).button).toHaveClass("primary");
  });

  it("stays focusable, says why and does nothing when disabled", async () => {
    const { button, onActivate } = setup({
      disabledReason: "Name every voice first.",
    });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(screen.getByText("Name every voice first.")).toBeVisible();
    expect(button).toHaveAccessibleDescription("Name every voice first.");
    await userEvent.tab();
    expect(button).toHaveFocus();
    await userEvent.click(button);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("is not disabled by an empty reason", async () => {
    const { button, onActivate } = setup({ disabledReason: "" });
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).not.toHaveAttribute("aria-describedby");
    await userEvent.click(button);
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it("shows Ctrl on other platforms and Cmd on Apple, and binds no key", async () => {
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });
    const first = setup();
    expect(first.button.querySelector(".sys-keys")).toHaveTextContent("Ctrl↵");
    const { onActivate } = first;
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("shows Cmd on Apple platforms", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    expect(setup().button.querySelector(".sys-keys")).toHaveTextContent("⌘↵");
  });

  it("drops the hint when asked to", () => {
    expect(
      setup({ keyHint: false }).button.querySelector(".sys-keys"),
    ).toBeNull();
  });

  it("drops the hint on the 48 px phone size", () => {
    expect(setup({ size: 48 }).button.querySelector(".sys-keys")).toBeNull();
  });
});
