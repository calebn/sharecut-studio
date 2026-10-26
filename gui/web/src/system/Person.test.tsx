import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PersonAvatar, PersonTile } from "./Person";

const MAYA = { name: "Maya Okafor", colorIndex: 0 };

describe("PersonAvatar", () => {
  it("shows initials and hides from assistive tech when the name is printed", () => {
    const { container } = render(<PersonAvatar person={MAYA} size={28} />);
    const avatar = container.firstElementChild;
    expect(avatar).toHaveTextContent("MO");
    expect(avatar).toHaveAttribute("aria-hidden", "true");
    expect(avatar).toHaveClass("sys-person-avatar--28");
  });

  it("is a button only when empty, and invites", async () => {
    const onInvite = vi.fn();
    render(<PersonTile onInvite={onInvite} />);
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect(onInvite).toHaveBeenCalledOnce();
  });

  it("sets the Saved text in an opaque success colour, not a translucent one", () => {
    const css = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../styles/partials/system.css",
      ),
      "utf8",
    );
    const rule = css.match(/\.sys-person-state--success \{([^}]*)\}/)?.[1];
    expect(rule).toContain("color: var(--color-success);");
    expect(rule).not.toContain("success-strong");
  });
});
