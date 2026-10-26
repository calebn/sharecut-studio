import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Suggestion } from "./Suggestion";

describe("Suggestion", () => {
  it("strikes the removed words and says so to a screen reader", () => {
    render(
      <Suggestion
        segments={[
          { text: "so " },
          { text: "um", struck: true },
          { text: " yes" },
        ]}
      />,
    );
    const struck = screen.getByText("um").closest("del");
    expect(struck).toHaveClass("sys-sugg-struck");
    expect(struck).toHaveTextContent("Removed: um");
  });

  it("underlines an unsure word", () => {
    render(<Suggestion segments={[{ text: "uncle", unsure: true }]} />);
    expect(screen.getByText("uncle")).toHaveClass("sys-sugg-unsure");
  });

  it("draws a pause as a hatched gap with its lengths", () => {
    const { container } = render(
      <Suggestion kind="pause" length={2.9} to={0.6} />,
    );
    expect(container.querySelector("svg pattern")).not.toBeNull();
    expect(screen.getByText("2.9 s")).toBeInTheDocument();
    expect(screen.getByText("0.6 s")).toBeInTheDocument();
  });

  it("in focus mode keeps the change in its own span between the context", () => {
    const { container } = render(
      <Suggestion
        focus
        segments={[
          { text: "so the mill is " },
          { text: "um", struck: true },
          { text: " nobody asked" },
        ]}
      />,
    );
    expect(container.querySelector(".sys-sugg-change")).toHaveTextContent(
      "Removed: um",
    );
    expect(container.querySelector(".sys-sugg-lead")).toHaveTextContent(
      "so the mill is",
    );
    expect(container.querySelector(".sys-sugg-trail")).toHaveTextContent(
      "nobody asked",
    );
  });
});
