import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClipsRow } from "./ClipsRow";
import { CLIPS, TOTAL } from "./deliverFixture";

function renderRow(extra: Partial<React.ComponentProps<typeof ClipsRow>> = {}) {
  render(
    <ClipsRow
      clips={CLIPS}
      total={TOTAL}
      onRetitle={vi.fn()}
      onTrim={vi.fn()}
      onPlay={vi.fn()}
      onApprove={vi.fn()}
      onRemove={vi.fn()}
      onOpenInEdit={vi.fn()}
      onFind={vi.fn()}
      {...extra}
    />,
  );
}

describe("ClipsRow editable", () => {
  it("edits titles and offers Approve by default", () => {
    renderRow();
    expect(
      screen.getAllByRole("textbox", { name: /^Title of/ }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: /^Approve / }).length,
    ).toBeGreaterThan(0);
  });

  it("shows titles as text and no Approve when editable is false", () => {
    renderRow({ editable: false });
    expect(screen.queryAllByRole("textbox", { name: /^Title of/ })).toEqual([]);
    expect(screen.queryAllByRole("button", { name: /^Approve / })).toEqual([]);
    expect(screen.getByText(CLIPS[0].title)).toBeVisible();
  });
});
