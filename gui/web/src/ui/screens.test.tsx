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

  it("names the next step beside the problem and is axe-clean", async () => {
    const { container } = render(
      <ErrorScreen
        message="This link does not open the project."
        hint="Ask the person who shared it for a new link."
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("This link does not open the project.");
    expect(alert).toHaveTextContent(
      "Ask the person who shared it for a new link.",
    );
    await expectNoA11yViolations(container);
  });
});
