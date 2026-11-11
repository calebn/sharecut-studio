import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ClipsRow } from "./ClipsRow";
import { CLIPS, TOTAL } from "./deliverFixture";

function renderRow(extra: Partial<React.ComponentProps<typeof ClipsRow>> = {}) {
  return render(
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

describe("ClipsRow Unapprove", () => {
  const approved = CLIPS.map((c) => ({ ...c, approved: true }));

  it("is offered on an approved clip when editable and reports the id", async () => {
    const onUnapprove = vi.fn();
    renderRow({ clips: approved, onUnapprove });
    const buttons = screen.getAllByRole("button", { name: /^Unapprove / });
    expect(buttons).toHaveLength(approved.length);
    await userEvent.click(buttons[0] as HTMLElement);
    expect(onUnapprove).toHaveBeenCalledWith(approved[0]?.id);
  });

  it("is left out when not editable", () => {
    renderRow({ clips: approved, onUnapprove: vi.fn(), editable: false });
    expect(screen.queryAllByRole("button", { name: /^Unapprove / })).toEqual(
      [],
    );
  });

  it("is left out on a clip that is not approved", () => {
    const pending = CLIPS.map((c) => ({ ...c, approved: false }));
    renderRow({ clips: pending, onUnapprove: vi.fn() });
    expect(screen.queryAllByRole("button", { name: /^Unapprove / })).toEqual(
      [],
    );
  });
});

describe("ClipsRow commitTitles", () => {
  it("caps a title at 200 characters", () => {
    renderRow({ commitTitles: true });
    const [first] = screen.getAllByRole("textbox", { name: /^Title of/ });
    expect(first).toHaveAttribute("maxlength", "200");
  });

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

describe("ClipsRow Find clips", () => {
  it("reads unavailable with the reason while it runs and does not report a click", async () => {
    const onFind = vi.fn();
    renderRow({ finding: true, onFind });
    const find = screen.getByRole("button", { name: "Find clips" });
    expect(find).toBeDisabled();
    expect(find).toHaveAttribute("title", "Finding clips…");
    await userEvent.click(find);
    expect(onFind).not.toHaveBeenCalled();
  });
});

describe("ClipsRow In and Out", () => {
  const id = CLIPS[0]?.id;
  const name = CLIPS[0]?.title;

  it("shows both edges as spinbuttons on the trimmed card only", () => {
    renderRow({ trimming: id });
    expect(
      screen.getByRole("spinbutton", { name: `In of ${name}` }),
    ).toHaveAttribute("aria-valuenow", String(CLIPS[0]?.start));
    expect(
      screen.getByRole("spinbutton", { name: `Out of ${name}` }),
    ).toHaveAttribute("aria-valuenow", String(CLIPS[0]?.end));
    expect(screen.getAllByRole("spinbutton", { name: /^In of / })).toHaveLength(
      1,
    );
  });

  it("reports a typed Out once, on Enter", async () => {
    const onTrim = vi.fn();
    renderRow({ trimming: id, onTrim });
    await userEvent.click(
      screen.getByRole("spinbutton", { name: `Out of ${name}` }),
    );
    await userEvent.keyboard("{Control>}a{/Control}700");
    expect(onTrim).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(onTrim).toHaveBeenCalledExactlyOnceWith(id, "end", 700);
  });

  it("labels the two fields In and Out where they can be seen", () => {
    renderRow({ trimming: id });
    const labels = document.querySelectorAll(".dv-part-label");
    expect([...labels].map((node) => node.textContent)).toEqual(["In", "Out"]);
  });

  it("reports nothing for an edge opened and left as it was", async () => {
    const onTrim = vi.fn();
    renderRow({ trimming: id, onTrim });
    await userEvent.click(
      screen.getByRole("spinbutton", { name: `In of ${name}` }),
    );
    await userEvent.keyboard("{Enter}");
    expect(onTrim).not.toHaveBeenCalled();
  });

  it("leaves a word-snapped edge alone when it is opened and left", async () => {
    const onTrim = vi.fn();
    const [first, ...rest] = CLIPS;
    if (!first) throw new Error("fixture has no clips");
    renderRow({
      clips: [{ ...first, start: 612.1234 }, ...rest],
      trimming: first.id,
      onTrim,
    });
    await userEvent.click(
      screen.getByRole("spinbutton", { name: `In of ${first.title}` }),
    );
    await userEvent.keyboard("{Enter}");
    expect(onTrim).not.toHaveBeenCalled();
  });

  it("commits a typed edge still open when the row goes away", async () => {
    const onTrim = vi.fn();
    const view = renderRow({ trimming: id, onTrim });
    await userEvent.click(
      screen.getByRole("spinbutton", { name: `Out of ${name}` }),
    );
    await userEvent.keyboard("{Control>}a{/Control}701");
    view.unmount();
    expect(onTrim).toHaveBeenCalledExactlyOnceWith(id, "end", 701);
  });

  it("refuses a typed Out past the end of the episode", async () => {
    const onTrim = vi.fn();
    renderRow({ trimming: id, onTrim });
    await userEvent.click(
      screen.getByRole("spinbutton", { name: `Out of ${name}` }),
    );
    await userEvent.keyboard("{Control>}a{/Control}999999{Enter}");
    expect(onTrim).not.toHaveBeenCalled();
  });

  it("reports a pointer drag once, on release", () => {
    const onTrim = vi.fn();
    renderRow({ trimming: id, onTrim });
    const field = screen.getByRole("spinbutton", { name: `In of ${name}` });
    fireEvent.pointerDown(field, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(field, { clientX: 110, pointerId: 1 });
    fireEvent.pointerMove(field, { clientX: 140, pointerId: 1 });
    expect(onTrim).not.toHaveBeenCalled();
    expect(field).not.toHaveAttribute("aria-valuenow", String(CLIPS[0]?.start));
    fireEvent.pointerUp(field, { clientX: 140, pointerId: 1 });
    expect(onTrim).toHaveBeenCalledTimes(1);
  });
});
