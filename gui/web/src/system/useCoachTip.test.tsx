import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { _resetCoachTipsForTests, coachTipOwner } from "../utils/coachTip";
import { CoachTip } from "./CoachTip";
import { useCoachTip } from "./useCoachTip";

beforeEach(() => {
  localStorage.clear();
  _resetCoachTipsForTests();
  useDawStore.setState({ pointerKind: "coarse" });
});
afterEach(() => vi.unstubAllGlobals());

function Probe() {
  const tip = useCoachTip("trim");
  return (
    <CoachTip
      text={tip.text}
      shown={tip.shown}
      onDismiss={tip.dismiss}
      placement="below"
    >
      <button type="button" onPointerDown={tip.show}>
        Anchor
      </button>
    </CoachTip>
  );
}

describe("useCoachTip", () => {
  it("shows after a trigger and hides after dismiss", () => {
    const { result } = renderHook(() => useCoachTip("trim"));
    expect(result.current.shown).toBe(false);
    act(() => result.current.show());
    expect(result.current.shown).toBe(true);
    expect(result.current.text).toBe("Drag the edges to trim");
    act(() => result.current.dismiss());
    expect(result.current.shown).toBe(false);
    expect(localStorage.getItem("sharecut.coachTipSeen.trim")).toBe("1");
  });

  it("stays hidden on remount once seen", () => {
    const a = renderHook(() => useCoachTip("trim"));
    act(() => a.result.current.show());
    act(() => a.result.current.dismiss());
    a.unmount();
    _resetCoachTipsForTests();
    const b = renderHook(() => useCoachTip("trim"));
    act(() => b.result.current.show());
    expect(b.result.current.shown).toBe(false);
  });

  it("ignores a fine pointer", () => {
    useDawStore.setState({ pointerKind: "fine" });
    const { result } = renderHook(() => useCoachTip("undo"));
    act(() => result.current.show());
    expect(result.current.shown).toBe(false);
  });

  it("shows one tip at a time", () => {
    const a = renderHook(() => useCoachTip("trim"));
    const b = renderHook(() => useCoachTip("undo"));
    act(() => a.result.current.show());
    act(() => b.result.current.show());
    expect(a.result.current.shown).toBe(true);
    expect(b.result.current.shown).toBe(false);
  });

  it("frees the slot when the owner unmounts unseen", () => {
    const a = renderHook(() => useCoachTip("trim"));
    const b = renderHook(() => useCoachTip("undo"));
    act(() => a.result.current.show());
    a.unmount();
    act(() => b.result.current.show());
    expect(b.result.current.shown).toBe(true);
  });

  it("renders correctly when localStorage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    const { result } = renderHook(() => useCoachTip("trim"));
    act(() => result.current.show());
    expect(result.current.shown).toBe(true);
    act(() => result.current.dismiss());
    expect(result.current.shown).toBe(false);
  });

  it("shows only for the instance that raised it", () => {
    const a = renderHook(() => useCoachTip("trim"));
    const b = renderHook(() => useCoachTip("trim"));
    act(() => a.result.current.show());
    expect(a.result.current.shown).toBe(true);
    expect(b.result.current.shown).toBe(false);
    b.unmount();
    expect(a.result.current.shown).toBe(true);
  });
});

describe("useCoachTip dismissal by any action", () => {
  it("survives the press that raised it", () => {
    render(<Probe />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Anchor" }));
    expect(screen.getByRole("note")).toHaveTextContent(
      "Drag the edges to trim",
    );
  });

  it("goes on the next press elsewhere and is remembered", () => {
    render(<Probe />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Anchor" }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("note")).toBeNull();
    expect(localStorage.getItem("sharecut.coachTipSeen.trim")).toBe("1");
  });

  it.each(["Shift", "Control", "Alt", "Meta", "Tab"])(
    "ignores a %s press on its own",
    (key) => {
      render(<Probe />);
      fireEvent.pointerDown(screen.getByRole("button", { name: "Anchor" }));
      fireEvent.keyDown(document.body, { key });
      expect(screen.getByRole("note")).toBeInTheDocument();
      expect(localStorage.getItem("sharecut.coachTipSeen.trim")).toBeNull();
    },
  );

  it("goes on the next key", () => {
    render(<Probe />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Anchor" }));
    fireEvent.keyDown(document.body, { key: "a" });
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("goes through the close button, which hands focus back to the anchor", async () => {
    render(<Probe />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Anchor" }));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss hint" }));
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByRole("button", { name: "Anchor" })).toHaveFocus();
  });
});

describe("useCoachTip after unmount", () => {
  it("does not claim the slot for a raise that lands late", () => {
    const { result, unmount } = renderHook(() => useCoachTip("rangeToggle"));
    unmount();
    result.current.show();
    expect(coachTipOwner()).toBeNull();
    render(<Probe />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Anchor" }));
    expect(screen.getByRole("note")).toBeInTheDocument();
  });

  it("frees the slot on release and keeps the tip unseen", () => {
    const { result } = renderHook(() => useCoachTip("trim"));
    act(() => result.current.show());
    expect(coachTipOwner()).not.toBeNull();
    act(() => result.current.release());
    expect(coachTipOwner()).toBeNull();
    expect(localStorage.getItem("sharecut.coachTipSeen.trim")).toBeNull();
  });
});
