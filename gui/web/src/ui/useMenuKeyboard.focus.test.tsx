import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useMenuKeyboard } from "./useMenuKeyboard";

afterEach(cleanup);

function Menu() {
  const ref = useRef<HTMLDivElement>(null);
  useMenuKeyboard({ open: true, panelRef: ref, close: () => undefined });
  return (
    <div ref={ref} role="menu">
      <button type="button" role="menuitem">
        Item
      </button>
    </div>
  );
}

async function openMenuFrom(opener: HTMLElement) {
  document.body.append(opener);
  opener.focus();
  const view = render(<Menu />);
  await waitFor(() => expect(screen.getByRole("menuitem")).toHaveFocus());
  return view;
}

describe("useMenuKeyboard focus return", () => {
  it("gives focus back to the opener when the menu closes", async () => {
    const opener = document.createElement("button");
    const { unmount } = await openMenuFrom(opener);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("does not give focus back to an opener inside an inert ancestor", async () => {
    const host = document.createElement("div");
    const opener = document.createElement("button");
    host.append(opener);
    document.body.append(host);
    opener.focus();
    const { unmount } = render(<Menu />);
    await waitFor(() => expect(screen.getByRole("menuitem")).toHaveFocus());
    host.setAttribute("inert", "");
    unmount();
    expect(document.activeElement).not.toBe(opener);
    host.remove();
  });
});
