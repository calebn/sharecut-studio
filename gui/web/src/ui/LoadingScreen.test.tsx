import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { LoadingScreen } from "./LoadingScreen";

it("announces loading without requiring focus", async () => {
  const { container } = render(<LoadingScreen label="Loading studio…" />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading studio…");
  await expectNoA11yViolations(container);
});
