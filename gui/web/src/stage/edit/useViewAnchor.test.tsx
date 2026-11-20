import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOverlay, openOverlay } from "../../ui/modalGate";
import { useViewAnchor, type ViewAnchorAvailability } from "./useViewAnchor";

let setHidden: (hidden: boolean) => void = () => {};

function Harness() {
  const [open, setOpen] = useState(true);
  const [hidden, hide] = useState(false);
  useEffect(() => {
    setHidden = hide;
  }, []);
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
  vi.useRealTimers();
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

  it("leaves focus on the fallback after a press on empty space", async () => {
    render(<Harness />);
    screen.getByRole("button", { name: "Prosody" }).focus();
    act(() => setHidden(true));
    const pane = document.querySelector<HTMLElement>("#pane");
    act(() => {
      pane?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    act(() => {
      appendFind();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(document.activeElement).toBe(pane);
  });

  it("gives up after five seconds", async () => {
    vi.useFakeTimers();
    render(<Harness />);
    screen.getByRole("button", { name: "Prosody" }).focus();
    act(() => setHidden(true));
    const pane = document.querySelector<HTMLElement>("#pane");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5001);
    });
    act(() => {
      appendFind();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(document.activeElement).toBe(pane);
  });

  it("leaves focus on the fallback once the eye is available again", async () => {
    render(<Harness />);
    screen.getByRole("button", { name: "Prosody" }).focus();
    act(() => setHidden(true));
    const pane = document.querySelector<HTMLElement>("#pane");
    act(() => setHidden(false));
    act(() => {
      appendFind();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(document.activeElement).toBe(pane);
  });

  it("leaves focus alone when a modal opens during the wait", async () => {
    render(<Harness />);
    screen.getByRole("button", { name: "Prosody" }).focus();
    act(() => setHidden(true));
    const pane = document.querySelector<HTMLElement>("#pane");
    const layer = openOverlay(true);
    act(() => {
      appendFind();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    closeOverlay(layer);
    expect(document.activeElement).toBe(pane);
  });

  it("stops watching when the hook unmounts", () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const view = render(<Harness />);
    screen.getByRole("button", { name: "Prosody" }).focus();
    act(() => setHidden(true));
    expect(disconnect).not.toHaveBeenCalled();
    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
    disconnect.mockRestore();
  });

  it("leaves focus on the fallback after a key press", async () => {
    render(<Harness />);
    screen.getByRole("button", { name: "Prosody" }).focus();
    act(() => setHidden(true));
    const pane = document.querySelector<HTMLElement>("#pane");
    act(() => {
      pane?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    });
    act(() => {
      appendFind();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(document.activeElement).toBe(pane);
  });

  it("does not move focus back after it left the fallback and returned", async () => {
    render(<Harness />);
    screen.getByRole("button", { name: "Prosody" }).focus();
    act(() => setHidden(true));
    const pane = document.querySelector<HTMLElement>("#pane");
    screen.getByRole("button", { name: "Elsewhere" }).focus();
    pane?.focus();
    act(() => {
      appendFind();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(document.activeElement).toBe(pane);
  });

  it("returns straight to the preferred control when it is already drawn", () => {
    const find = appendFind();
    render(<Harness />);
    screen.getByRole("button", { name: "Prosody" }).focus();
    act(() => setHidden(true));
    expect(document.activeElement).toBe(find);
  });
});
