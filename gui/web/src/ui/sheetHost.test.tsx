import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SheetHostPlacement } from "./sheetHost";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function hostWithFocusedButton() {
  const host = document.createElement("div");
  const button = document.createElement("button");
  host.append(button);
  document.body.append(host);
  button.focus();
  return { host, button };
}

describe("SheetHostPlacement", () => {
  it("drops focus held inside the host when it becomes inert", () => {
    const { host, button } = hostWithFocusedButton();
    expect(document.activeElement).toBe(button);
    const { rerender } = render(
      <SheetHostPlacement host={host} column={false} stowed={false} />,
    );
    expect(host).not.toHaveAttribute("inert");
    rerender(<SheetHostPlacement host={host} column={false} stowed />);
    expect(host).toHaveAttribute("inert");
    expect(document.activeElement).not.toBe(button);
  });

  it("leaves focus alone when the host stays live", () => {
    const { host, button } = hostWithFocusedButton();
    render(<SheetHostPlacement host={host} column={false} stowed={false} />);
    expect(document.activeElement).toBe(button);
  });
});
