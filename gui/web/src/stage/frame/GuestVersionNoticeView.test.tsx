import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { GuestVersionNoticeView } from "./GuestVersionNoticeView";

const base = {
  label: "Final cut",
  followsLatest: false,
  newer: null,
  changed: false,
  author: "Caleb",
  onReload: () => {},
};

describe("GuestVersionNoticeView", () => {
  it("names the version a frozen link stays on", async () => {
    const { container } = render(<GuestVersionNoticeView {...base} />);
    expect(screen.getByRole("status").textContent).toBe(
      'Hearing "Final cut". This link stays on this version.',
    );
    expect(screen.queryByRole("button")).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("tells a frozen link that a newer version exists and who to ask", () => {
    render(<GuestVersionNoticeView {...base} newer={{ label: "Cut 2" }} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe(
      'Hearing "Final cut". Newer version available: "Cut 2". Ask Caleb for a new link.',
    );
    expect(status.className).toContain("guest-version--attention");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("falls back when the author and the newer label are unnamed", () => {
    render(
      <GuestVersionNoticeView
        {...base}
        author={null}
        newer={{ label: null }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Newer version available: an unnamed version. Ask the person who shared this for a new link.",
    );
  });

  it("warns a following link that the mix can change", () => {
    render(<GuestVersionNoticeView {...base} followsLatest />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe(
      'Hearing "Final cut". This link follows the latest version, so it can change.',
    );
    expect(status.className).not.toContain("guest-version--attention");
  });

  it("offers a reload when a following link changed", async () => {
    const onReload = vi.fn();
    render(
      <GuestVersionNoticeView
        {...base}
        label="Cut 2"
        followsLatest
        changed
        onReload={onReload}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      'The shared version changed to "Cut 2". Reload to hear it.',
    );
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
