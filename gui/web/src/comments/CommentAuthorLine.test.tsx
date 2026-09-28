import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { CommentAuthorLine } from "./CommentAuthorLine";

describe("CommentAuthorLine", () => {
  it("shows Commenting as <name> and passes axe", async () => {
    const { container } = render(
      <CommentAuthorLine name="Caleb" onChange={vi.fn()} />,
    );
    expect(screen.getByText(/Commenting as/)).toBeInTheDocument();
    expect(screen.getByText("Caleb")).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("Change opens a pre-filled field named Your name, and passes axe", async () => {
    const { container } = render(
      <CommentAuthorLine name="Caleb" onChange={vi.fn()} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Change your comment name" }),
    );
    const input = screen.getByRole("textbox", { name: "Your name" });
    expect(input).toHaveValue("Caleb");
    await expectNoA11yViolations(container);
  });

  it("typing plus Enter saves and returns focus to Change", () => {
    const onChange = vi.fn();
    render(<CommentAuthorLine name="Caleb" onChange={onChange} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Change your comment name" }),
    );
    const input = screen.getByRole("textbox", { name: "Your name" });
    fireEvent.change(input, { target: { value: "Ada" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("Ada");
    expect(
      screen.getByRole("button", { name: "Change your comment name" }),
    ).toHaveFocus();
  });

  it("Escape cancels without calling onChange and keeps the old name", () => {
    const onChange = vi.fn();
    render(<CommentAuthorLine name="Caleb" onChange={onChange} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Change your comment name" }),
    );
    const input = screen.getByRole("textbox", { name: "Your name" });
    fireEvent.change(input, { target: { value: "Ada" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("Caleb")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Change your comment name" }),
    ).toHaveFocus();
  });

  it("tabbing out saves and leaves focus on the next control", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <CommentAuthorLine name="Caleb" onChange={onChange} />
        <button type="button">Open</button>
      </>,
    );
    await user.click(
      screen.getByRole("button", { name: "Change your comment name" }),
    );
    const input = screen.getByRole("textbox", { name: "Your name" });
    await user.clear(input);
    await user.type(input, "Ada");
    await user.tab();
    expect(onChange).toHaveBeenCalledWith("Ada");
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
  });

  it("clicking another control saves and keeps focus there", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <CommentAuthorLine name="Caleb" onChange={onChange} />
        <button type="button">Open</button>
      </>,
    );
    await user.click(
      screen.getByRole("button", { name: "Change your comment name" }),
    );
    const input = screen.getByRole("textbox", { name: "Your name" });
    await user.clear(input);
    await user.type(input, "Ada");
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(onChange).toHaveBeenCalledWith("Ada");
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
  });

  it("clicking into another text field saves and keeps typing there", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <CommentAuthorLine name="Caleb" onChange={onChange} />
        <input aria-label="Reply" />
      </>,
    );
    await user.click(
      screen.getByRole("button", { name: "Change your comment name" }),
    );
    const input = screen.getByRole("textbox", { name: "Your name" });
    await user.clear(input);
    await user.type(input, "Ada");
    await user.click(screen.getByRole("textbox", { name: "Reply" }));
    await user.keyboard("hi");
    expect(onChange).toHaveBeenCalledWith("Ada");
    const reply = screen.getByRole("textbox", { name: "Reply" });
    expect(reply).toHaveFocus();
    expect(reply).toHaveValue("hi");
  });

  it("blurring an empty value calls nothing", () => {
    const onChange = vi.fn();
    render(<CommentAuthorLine name="Caleb" onChange={onChange} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Change your comment name" }),
    );
    const input = screen.getByRole("textbox", { name: "Your name" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });
});
