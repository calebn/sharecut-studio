import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Marker, type MarkerProps } from "./Marker";

const onSelect = () => undefined;

describe("Marker", () => {
  it("shows a chapter as a flag with its title and names it with its time", () => {
    render(
      <Marker
        kind="chapter"
        title="Cold open"
        time="0:00"
        at={0}
        onSelect={onSelect}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Chapter Cold open, 0:00" }),
    ).toHaveTextContent("Cold open");
  });

  it("puts the author's capital initial in a comment pin", () => {
    render(
      <Marker
        kind="comment"
        author="maya"
        time="12:04"
        at={0.2}
        onSelect={onSelect}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Comment by maya, 12:04" }),
    ).toHaveTextContent("M");
  });

  it("draws a bar only for a comment with a range", () => {
    const { container, rerender } = render(
      <Marker
        kind="comment"
        author="Maya"
        time="12:04"
        at={0.2}
        onSelect={onSelect}
      />,
    );
    expect(container.querySelector(".sys-marker-bar")).toBeNull();
    rerender(
      <Marker
        kind="comment"
        author="Maya"
        time="12:04"
        at={0.2}
        to={0.4}
        onSelect={onSelect}
      />,
    );
    expect(container.querySelector(".sys-marker-bar")).not.toBeNull();
    expect(container.querySelector(".sys-marker")).toHaveStyle({
      "--sys-marker-to": "0.4",
    });
  });

  it("says whether a clip idea is proposed or approved", () => {
    const idea = {
      kind: "clip",
      title: "Origin story",
      time: "4:10",
      at: 0.1,
      to: 0.3,
      onSelect,
    } as const;
    const { container, rerender } = render(<Marker {...idea} proposed />);
    expect(
      screen.getByRole("button", {
        name: "Clip idea Origin story, proposed, 4:10",
      }),
    ).toBeInTheDocument();
    expect(container.querySelector(".sys-marker")).toHaveAttribute(
      "data-proposed",
      "true",
    );
    rerender(<Marker {...idea} proposed={false} />);
    expect(
      screen.getByRole("button", {
        name: "Clip idea Origin story, approved, 4:10",
      }),
    ).toBeInTheDocument();
    expect(container.querySelector(".sys-marker")).not.toHaveAttribute(
      "data-proposed",
    );
  });

  it("opens the list from a stack", async () => {
    const open = vi.fn();
    render(<Marker kind="stack" count={3} at={0.5} onSelect={open} />);
    const stack = screen.getByRole("button", { name: "3 more markers" });
    expect(stack).toHaveTextContent("+3");
    expect(stack).not.toHaveAttribute("aria-pressed");
    await userEvent.click(stack);
    expect(open).toHaveBeenCalledOnce();
    fireEvent.pointerEnter(stack, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows the full title and the time in a tip on hover", () => {
    render(
      <Marker
        kind="chapter"
        title="The long way round"
        time="26:05"
        at={0.5}
        to={0.55}
        onSelect={onSelect}
      />,
    );
    fireEvent.pointerEnter(screen.getByRole("button"), {
      pointerType: "mouse",
    });
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "The long way round26:05",
    );
  });

  it("shows the commenter in the tip of a comment", () => {
    render(
      <Marker
        kind="comment"
        author="Maya"
        time="12:04"
        at={0.2}
        onSelect={onSelect}
      />,
    );
    fireEvent.pointerEnter(screen.getByRole("button"), {
      pointerType: "mouse",
    });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Maya12:04");
  });

  it("marks the selected marker and positions it by fraction of the lane", () => {
    const props: MarkerProps = {
      kind: "chapter",
      title: "Intro",
      time: "0:00",
      at: 0.25,
      selected: true,
      onSelect,
    };
    const { container } = render(<Marker {...props} />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector(".sys-marker")).toHaveStyle({
      "--sys-marker-at": "0.25",
    });
  });
});
