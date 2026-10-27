import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { LoadFailureBanner } from "./LoadFailureBanner";

describe("LoadFailureBanner", () => {
  it("says what failed and why, and retries", async () => {
    const onRetry = vi.fn();
    const { container } = render(
      <LoadFailureBanner
        failure={{ message: "The server didn't answer.", onRetry }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Could not load transcript and history. The server didn't answer.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    await expectNoA11yViolations(container);
  });

  it("shows a polite retrying line while the server is still busy", async () => {
    const { container } = render(
      <LoadFailureBanner
        failure={{
          message: "The server is still working. Retrying…",
          onRetry: vi.fn(),
          recovering: true,
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Still loading transcript and history.",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("renders nothing without a failure", () => {
    const { container } = render(<LoadFailureBanner failure={null} />);
    expect(container.firstChild).toBeNull();
  });
});
