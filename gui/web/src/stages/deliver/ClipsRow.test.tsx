import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

describe("ClipsRow commitTitles", () => {
  it("reports a retitle on every keystroke by default", async () => {
    const onRetitle = vi.fn();
    renderRow({ onRetitle });
    const [first] = screen.getAllByRole("textbox", { name: /^Title of/ });
    await userEvent.type(first as HTMLElement, "ab");
    expect(onRetitle).toHaveBeenCalledTimes(2);
  });

  it("reports one retitle on Enter, and none for text left as it was", async () => {
    const onRetitle = vi.fn();
    renderRow({ onRetitle, commitTitles: true });
    const [first] = screen.getAllByRole("textbox", { name: /^Title of/ });
    await userEvent.type(first as HTMLElement, "ab");
    expect(onRetitle).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(onRetitle).toHaveBeenCalledOnce();
    expect(onRetitle).toHaveBeenCalledWith(CLIPS[0].id, `${CLIPS[0].title}ab`);
    await userEvent.keyboard("{Backspace}{Backspace}");
    await userEvent.tab();
    expect(onRetitle).toHaveBeenCalledTimes(1);
  });
});
