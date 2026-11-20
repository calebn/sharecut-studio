import { act, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { type ViewAnchorAvailability, useViewAnchor } from "./useViewAnchor";

let setHidden: (hidden: boolean) => void = () => {};

function Harness() {
  const [open, setOpen] = useState(true);
  const [hidden, hide] = useState(false);
  setHidden = hide;
  const panel = useRef<HTMLDivElement>(null);
  const availability: ViewAnchorAvailability = hidden
    ? {
        kind: "unavailable",
        returnTarget: () =>
          document.querySelector<HTMLElement>("[aria-label='Find']") ??
          document.querySelector<HTMLElement>("#pane"),
        preferredTarget: () =>
          document.querySelector<HTMLElement>("[aria-label='Find']"),
      }
    : { kind: "available" };
  useViewAnchor(open, availability, panel, () => setOpen(false));
  return (
    <>
      {open ? (
        <div ref={panel}>
          <button type="button">Prosody</button>
        </div>
      ) : null}
      <div id="pane" tabIndex={-1}>
        <button type="button">Elsewhere</button>
      </div>
    </>
  );
}

function appendFind() {
  const button = document.createElement("button");
  button.setAttribute("aria-label", "Find");
  document.body.append(button);
  return button;
}

afterEach(() => {
  document.querySelector("[aria-label='Find']")?.remove();
});

describe("the View anchor's focus return", () => {
  it("moves focus to the preferred control when it appears after the fallback took focus", async () => {
    render(<Harness />);
    screen.getByRole("button", { name: "Prosody" }).focus();
    act(() => setHidden(true));
    expect(document.activeElement).toBe(document.querySelector("#pane"));
    let find: HTMLElement | undefined;
    act(() => {
      find = appendFind();
    });
    await waitFor(() => expect(document.activeElement).toBe(find));
  });

  it("leaves focus alone once the user has moved it", async () => {
    render(<Harness />);
    screen.getByRole("button", { name: "Prosody" }).focus();
    act(() => setHidden(true));
    screen.getByRole("button", { name: "Elsewhere" }).focus();
    act(() => {
      appendFind();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Elsewhere" }),
    );
  });

  it("returns straight to the preferred control when it is already drawn", () => {
    const find = appendFind();
    render(<Harness />);
    screen.getByRole("button", { name: "Prosody" }).focus();
    act(() => setHidden(true));
    expect(document.activeElement).toBe(find);
  });
});
