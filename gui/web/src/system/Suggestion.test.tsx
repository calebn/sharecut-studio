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
});
