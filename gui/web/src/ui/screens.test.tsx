import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { ErrorScreen } from "./ErrorScreen";
import { LoadingScreen } from "./LoadingScreen";

describe("LoadingScreen", () => {
  it("is axe-clean", async () => {
    const { container } = render(<LoadingScreen label="Loading project…" />);
    expect(screen.getByText("Loading project…")).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });
});

describe("ErrorScreen", () => {
  it("is axe-clean", async () => {
    const { container } = render(
      <ErrorScreen message="Missing ?project= query parameter" />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Missing ?project= query parameter",
    );
    await expectNoA11yViolations(container);
  });
});
