import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GapMark } from "./GapMark";

describe("GapMark", () => {
  it("labels the gap trim mode and optional detail", () => {
    render(<GapMark detail="+0.4 s" />);
    expect(screen.getByText("Gap")).toBeInTheDocument();
    expect(screen.getByText("+0.4 s")).toBeInTheDocument();
  });
});
