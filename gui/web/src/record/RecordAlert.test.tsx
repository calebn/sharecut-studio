import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { RecordAlert } from "./RecordAlert";

describe("RecordAlert", () => {
  it("renders the message and runs the action", async () => {
    const fn = vi.fn();
    const { container, rerender } = render(
      <RecordAlert actionLabel="Do it" onAction={fn}>
        <span>Msg</span>
      </RecordAlert>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Msg");
    await userEvent.click(screen.getByRole("button", { name: "Do it" }));
    expect(fn).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
    rerender(
      <RecordAlert actionLabel="Do it">
        <span>Msg</span>
      </RecordAlert>,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
