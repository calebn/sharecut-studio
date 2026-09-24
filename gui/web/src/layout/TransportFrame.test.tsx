import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TransportFrame, TransportZone } from "./TransportFrame";

describe("TransportFrame", () => {
  it("renders a banner with state classes and named zones", () => {
    const { container } = render(
      <TransportFrame compact collapsed playing>
        <TransportZone position="start">a</TransportZone>
        <TransportZone position="end">b</TransportZone>
      </TransportFrame>,
    );
    const header = container.querySelector("header");
    expect(header).toHaveClass(
      "transport",
      "transport--compact",
      "transport--collapsed",
    );
    expect(header).toHaveAttribute("data-playing", "true");
    expect(
      [...container.querySelectorAll(".transport-zone")].map(
        (z) => z.className,
      ),
    ).toEqual([
      "transport-zone transport-zone--start",
      "transport-zone transport-zone--end",
    ]);
  });
});
