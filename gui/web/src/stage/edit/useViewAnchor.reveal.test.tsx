import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useViewAnchor, type ViewAnchorAvailability } from "./useViewAnchor";

let setHidden: (h: boolean) => void = () => {};
function Harness({ withPreferred = true }: { withPreferred?: boolean }) {
  const [open, setOpen] = useState(true);
  const [hidden, hide] = useState(false);
  useEffect(() => {
    setHidden = hide;
  }, []);
  const panel = useRef<HTMLDivElement>(null);
  const find = () => document.querySelector<HTMLElement>("[aria-label='Find']");
  const availability: ViewAnchorAvailability = hidden
    ? {
        kind: "unavailable",
        returnTarget: () => document.querySelector<HTMLElement>("#pane"),
        ...(withPreferred ? { preferredTarget: find } : {}),
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
        <div id="slot" />
      </div>
    </>
  );
}
const mk = (parent: Element = document.body) => {
  const b = document.createElement("button");
  b.setAttribute("aria-label", "Find");
  parent.append(b);
  return b;
};
afterEach(() => {
  document.querySelector("[aria-label='Find']")?.remove();
  document.querySelector("style")?.remove();
  vi.useRealTimers();
});
const start = () => {
  render(<Harness />);
  screen.getByRole("button", { name: "Prosody" }).focus();
  act(() => setHidden(true));
};

describe("the View anchor upgrade", () => {
  it("moves focus to the preferred control when it draws 4.5 s later", async () => {
    vi.useFakeTimers();
    start();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });
    let f!: HTMLElement;
    act(() => {
      f = mk();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(document.activeElement).toBe(f);
  });
  it("moves focus when the preferred control is revealed by the hidden attribute", async () => {
    const wrap = document.createElement("div");
    wrap.hidden = true;
    document.body.append(wrap);
    const f = mk(wrap);
    start();
    expect(document.activeElement).toBe(document.querySelector("#pane"));
    act(() => {
      wrap.hidden = false;
    });
    await waitFor(() => expect(document.activeElement).toBe(f));
    wrap.remove();
  });
  it("moves focus when the preferred control is revealed by a class", async () => {
    const st = document.createElement("style");
    st.textContent = ".gone{display:none}";
    document.head.append(st);
    const wrap = document.createElement("div");
    wrap.className = "gone";
    document.body.append(wrap);
    const f = mk(wrap);
    start();
    act(() => {
      wrap.className = "";
    });
    await waitFor(() => expect(document.activeElement).toBe(f));
    wrap.remove();
  });
  it("moves focus when the preferred control draws inside a nested container", async () => {
    start();
    let f!: HTMLElement;
    act(() => {
      f = mk(document.querySelector("#slot")!);
    });
    await waitFor(() => expect(document.activeElement).toBe(f));
  });
  it("returns to the fallback when the anchor names no preferred control", () => {
    render(<Harness withPreferred={false} />);
    screen.getByRole("button", { name: "Prosody" }).focus();
    act(() => setHidden(true));
    expect(document.activeElement).toBe(document.querySelector("#pane"));
  });
  it("stops on a press whose target stops propagation", async () => {
    start();
    const pane = document.querySelector<HTMLElement>("#pane")!;
    pane.addEventListener("pointerdown", (e) => e.stopPropagation());
    act(() => {
      pane.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    act(() => {
      mk();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(document.activeElement).toBe(pane);
  });
});
