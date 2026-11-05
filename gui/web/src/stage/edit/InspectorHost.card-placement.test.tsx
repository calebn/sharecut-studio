import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import {
  FakeResizeObserver,
  stubResizeObserver,
} from "../../test/resizeObserver";
import { InspectorHost } from "./InspectorHost";

const roots: HTMLElement[] = [];
const sheet = {
  open: true,
  strip: null,
  rangeActionsInSheet: false,
  close: vi.fn(),
  dismiss: vi.fn(),
};
const oldFontSize = document.documentElement.style.fontSize;

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  stubResizeObserver();
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  document.documentElement.style.fontSize = "16px";
  useDawStore
    .getState()
    .hydrate(
      "/tmp/card-placement/episode.sharecut",
      minimalProject({ tracks: [sampleTrack({ id: "host" })] }),
    );
  useDawStore.setState({
    stage: "edit",
    guestMode: null,
    selection: { kind: "track", trackId: "host" },
    rangeArmed: false,
    inspectorKey: null,
  });
});

afterEach(() => {
  cleanup();
  for (const root of roots.splice(0)) root.remove();
  document.documentElement.style.fontSize = oldFontSize;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearRegisteredCommands();
});

function geometry(withTarget = true) {
  const root = document.createElement("div");
  root.innerHTML = withTarget
    ? '<div class="lane-row" data-track-id="host"></div><div class="sys-actions--floating"></div>'
    : "";
  document.body.append(root);
  roots.push(root);
  const frame = vi
    .spyOn(root, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(10.2, 20.2, 1000.2, 800.2));
  let shift = 0;
  const lane = root.querySelector<HTMLElement>(".lane-row");
  const bar = root.querySelector<HTMLElement>(".sys-actions--floating");
  const target = lane
    ? vi
        .spyOn(lane, "getBoundingClientRect")
        .mockImplementation(
          () => new DOMRect(100.7, 200.4 + shift, 120.4, 40.2),
        )
    : null;
  const action = bar
    ? vi
        .spyOn(bar, "getBoundingClientRect")
        .mockImplementation(() => new DOMRect(90.1, 245.5 + shift, 160.8, 35.1))
    : null;
  return {
    root,
    frame,
    target,
    action,
    shift: (next: number) => {
      shift = next;
    },
  };
}

function host(root: HTMLElement | null) {
  return (
    <InspectorHost
      shell="desktop"
      sheet={sheet}
      root={root}
      regionRef={() => undefined}
    />
  );
}

describe("Inspector Card committed geometry", () => {
  it("uses the resolved anchor plus floating Action bar before any scheduled frame or observer report", () => {
    const fixture = geometry();
    render(host(fixture.root));
    const card = screen.getByRole("dialog", { name: "Inspector" });
    expect(fixture.target).toHaveBeenCalled();
    expect(fixture.action).toHaveBeenCalled();
    expect(card).toHaveAttribute("data-side", "below");
    expect(card.style.insetInlineStart).toBe("8px");
    expect(card.style.insetBlockStart).toBe("268px");
    expect(card.style.maxBlockSize).toBe("480px");
    expect(card).toContainElement(document.activeElement as HTMLElement);
  });

  it("measures the armed no-selection fallback without relying on anchor discovery to rerender", () => {
    useDawStore.setState({ selection: null, rangeArmed: true });
    const fixture = geometry(false);
    render(host(fixture.root));
    const card = screen.getByRole("dialog", { name: "Inspector" });
    expect(fixture.frame).toHaveBeenCalled();
    expect(card).toHaveAttribute("data-side", "above");
    expect(card.style.insetInlineStart).toBe("340px");
    expect(card.style.insetBlockEnd).toBe("8px");
    expect(card.style.maxBlockSize).toBe("480px");
    expect(card).toContainElement(document.activeElement as HTMLElement);
  });

  it("remeasures an actual changed selection even when it resolves to the same fallback lane", () => {
    const fixture = geometry();
    render(host(fixture.root));
    const before = fixture.frame.mock.calls.length;
    act(() =>
      useDawStore.setState({ selection: { kind: "track", trackId: "other" } }),
    );
    expect(screen.getByText("Track not found")).toBeInTheDocument();
    expect(fixture.frame.mock.calls.length).toBeGreaterThan(before);
  });

  it("preserves the same typed field and caret while real geometry ingress refreshes placement", () => {
    const fixture = geometry();
    const view = render(host(fixture.root));
    const card = screen.getByRole("dialog", { name: "Inspector" });
    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Name",
    });
    input.focus();
    const beforeTyping = fixture.frame.mock.calls.length;
    fireEvent.change(input, { target: { value: "Draft name" } });
    expect(fixture.frame).toHaveBeenCalledTimes(beforeTyping);
    input.setSelectionRange(2, 5);
    const beforeInnerScroll = fixture.frame.mock.calls.length;
    fixture.shift(100);
    fireEvent.scroll(input);
    expect(fixture.frame).toHaveBeenCalledTimes(beforeInnerScroll);
    expect(card.style.insetBlockStart).toBe("268px");
    fireEvent.scroll(fixture.root);
    expect(fixture.frame.mock.calls.length).toBeGreaterThan(beforeInnerScroll);
    expect(card.style.insetBlockStart).toBe("368px");
    fixture.shift(150);
    fireEvent.resize(window);
    const beforeObserver = fixture.frame.mock.calls.length;
    fixture.shift(200);
    act(() => FakeResizeObserver.of(fixture.root).fire(fixture.root));
    expect(fixture.frame.mock.calls.length).toBeGreaterThan(beforeObserver);
    expect(screen.getByRole("dialog", { name: "Inspector" })).toBe(card);
    expect(screen.getByRole("textbox", { name: "Name" })).toBe(input);
    expect(input).toHaveValue("Draft name");
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(5);
    const beforeZoom = fixture.frame.mock.calls.length;
    act(() => useDawStore.setState({ zoomPxPerSec: 321 }));
    expect(fixture.frame.mock.calls.length).toBeGreaterThan(beforeZoom);
    const beforeSelection = fixture.frame.mock.calls.length;
    act(() =>
      useDawStore.setState({ selection: { kind: "track", trackId: "host" } }),
    );
    expect(fixture.frame).toHaveBeenCalledTimes(beforeSelection);
    const other = geometry();
    view.rerender(host(other.root));
    expect(other.target).toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Name" })).toBe(input);
    expect(input).toHaveValue("Draft name");
    const lastStyle = card.getAttribute("style");
    view.rerender(host(null));
    expect(card.isConnected).toBe(true);
    expect(card.getAttribute("style")).toBe(lastStyle);
    view.rerender(host(other.root));
    expect(screen.getByRole("textbox", { name: "Name" })).toBe(input);
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(5);
  });
});
