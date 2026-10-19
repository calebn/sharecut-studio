import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BleedAttenuationRegion,
  bleedAttenuationRegionKey,
} from "../edit/bleedAttenuation";
import { LONG_PRESS_MS } from "../hooks/gestureConstants";
import { expectNoA11yViolations } from "../test/a11y";
import { place } from "../test/hitDom";
import { BleedAttenuationOverlay } from "./BleedAttenuationOverlay";
import {
  attachHitRouting,
  type ChooserView,
  type HitRouter,
} from "./hitRouting";
import { hitTargetProps } from "./hitTargets";
import { useTouchPress } from "./useTouchPress";

const region: BleedAttenuationRegion<{ seal: string }> = {
  trackId: "mira",
  occurrenceId: "one-copy",
  kind: "late_gate",
  sourceSpan: { start: 20, end: 21 },
  timelineSpan: { start: 5, end: 6 },
  restore: {
    state: "available",
    target: { seal: "opaque" },
    sourceSpan: { start: 20, end: 21 },
  },
};
describe("BleedAttenuationOverlay", () => {
  it("uses supplied geometry and selects the occurrence without triggering a lane click", async () => {
    const onSelect = vi.fn();
    const onClipClick = vi.fn();
    const { container } = render(
      <div onClick={onClipClick} role="presentation">
        <BleedAttenuationOverlay
          regions={[{ region, leftPx: 24, widthPx: 60 }]}
          selectedKey={bleedAttenuationRegionKey(region)}
          onSelect={onSelect}
        />
      </div>,
    );
    const button = screen.getByRole("button", {
      name: /^Automatic reduction,/,
    });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector(".bleed-attenuation-band")).toHaveStyle({
      left: "24px",
      width: "60px",
    });
    fireEvent.pointerDown(button);
    await userEvent.click(button);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(
      bleedAttenuationRegionKey(region),
    );
    expect(onClipClick).not.toHaveBeenCalled();
  });
  it("supports native keyboard selection and leaves controlled selection unchanged", async () => {
    const onSelect = vi.fn();
    render(
      <BleedAttenuationOverlay
        regions={[{ region, leftPx: 0, widthPx: 1 }]}
        selectedKey={null}
        onSelect={onSelect}
      />,
    );
    await userEvent.tab();
    const button = screen.getByRole("button");
    expect(button).toHaveFocus();
    await userEvent.keyboard("{Enter} ");
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(button).toHaveAttribute("aria-pressed", "false");
  });
  it("labels each automatic kind and remains empty without regions", () => {
    const { rerender } = render(
      <BleedAttenuationOverlay
        regions={[
          {
            region: { ...region, kind: "bleed_mute:off_speaker" },
            leftPx: 10,
            widthPx: 40,
          },
        ]}
        selectedKey={null}
        onSelect={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /^Automatic speaker mute,/ }),
    ).toBeVisible();
    rerender(
      <BleedAttenuationOverlay
        regions={[]}
        selectedKey={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });
  it("uses the shared accessibility check", async () => {
    const { container } = render(
      <BleedAttenuationOverlay
        regions={[{ region, leftPx: 0, widthPx: 60 }]}
        selectedKey={null}
        onSelect={vi.fn()}
      />,
    );
    await expectNoA11yViolations(container);
  });
});

function RoutedOverlay({
  onSelect,
  onChooser,
  onArm,
  crowded = false,
}: {
  onSelect: (key: string) => void;
  onChooser: (view: ChooserView | null) => void;
  onArm: () => void;
  crowded?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [router, setRouter] = useState<HitRouter | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!root.current) return;
    const routing = attachHitRouting(root.current, {
      onChooser,
      onArm,
      snapshot: () => {
        const before = selected.current;
        return () => {
          selected.current = before;
          setSelectedKey(before);
        };
      },
    });
    setRouter(routing);
    return () => routing.dispose();
  }, [onArm, onChooser]);
  const press = useTouchPress(router);
  return (
    <div ref={root} {...press}>
      <BleedAttenuationOverlay
        regions={[{ region, leftPx: 200, widthPx: 100 }]}
        selectedKey={selectedKey}
        onSelect={(key) => {
          selected.current = key;
          setSelectedKey(key);
          onSelect(key);
        }}
      />
      {crowded && (
        <button
          type="button"
          {...hitTargetProps("trim-out", "one-copy", 6)}
          onClick={() => onSelect("trim")}
        >
          Trim end
        </button>
      )}
    </div>
  );
}

describe("BleedAttenuationOverlay through central hit routing", () => {
  const touch = {
    pointerType: "touch",
    pointerId: 7,
    isPrimary: true,
    button: 0,
    clientX: 250,
    clientY: 164,
  };
  const onSelect = vi.fn<(key: string) => void>();
  const onChooser = vi.fn<(view: ChooserView | null) => void>();
  const onArm = vi.fn<() => void>();

  beforeEach(() => {
    vi.useFakeTimers();
    onSelect.mockReset();
    onChooser.mockReset();
    onArm.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mount(crowded = false) {
    const view = render(
      <RoutedOverlay
        onSelect={onSelect}
        onChooser={onChooser}
        onArm={onArm}
        crowded={crowded}
      />,
    );
    const band = screen.getByRole("button", { name: /^Automatic reduction,/ });
    place(band, { left: 200, top: 164, right: 300, bottom: 172 });
    const trim = screen.queryByRole("button", { name: "Trim end" });
    if (trim) place(trim, { left: 248, top: 106, right: 256, bottom: 174 });
    return { ...view, band, trim };
  }

  it.each(["mouse", "pen", "touch"])(
    "keeps a direct %s tap on the band when a trim handle is nearer",
    (pointerType) => {
      const { band } = mount(true);
      const pointer = { ...touch, pointerType };
      fireEvent.pointerDown(band, pointer);
      expect(onSelect).not.toHaveBeenCalled();
      fireEvent.pointerUp(band, pointer);
      fireEvent.click(band, { detail: 1 });
      act(() => {
        vi.runAllTimers();
      });
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(
        bleedAttenuationRegionKey(region),
      );
      expect(band).toHaveAttribute("aria-pressed", "true");
      expect(onArm).not.toHaveBeenCalled();
    },
  );

  it("selects an isolated long press without arming or dragging", () => {
    const { band } = mount();
    fireEvent.pointerDown(band, touch);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 1);
    });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(
      bleedAttenuationRegionKey(region),
    );
    fireEvent.pointerMove(band, { ...touch, clientX: 280 });
    fireEvent.pointerUp(band, { ...touch, clientX: 280 });
    act(() => {
      vi.runAllTimers();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onArm).not.toHaveBeenCalled();
    expect(band).not.toHaveAttribute("data-hit-armed");
  });

  it("keeps the nearby trim and band in the long-press chooser", () => {
    const { band } = mount(true);
    fireEvent.pointerDown(band, touch);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 1);
    });
    const chooser = onChooser.mock.calls.at(-1)?.[0];
    expect(chooser).toBeDefined();
    expect(chooser?.hits.map(({ candidate }) => candidate.kind)).toEqual([
      "trim-out",
      "bleed-attenuation",
    ]);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onArm).not.toHaveBeenCalled();
    fireEvent.pointerCancel(band, touch);
  });

  it("selects nothing when the browser takes the press to scroll", () => {
    const { band } = mount();
    fireEvent.pointerDown(band, touch);
    fireEvent.pointerMove(band, { ...touch, clientY: 200 });
    fireEvent.pointerCancel(band, touch);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(band).toHaveAttribute("aria-pressed", "false");
  });

  it("rolls long-press selection back when a second finger lands", () => {
    const { band } = mount();
    fireEvent.pointerDown(band, touch);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 1);
    });
    expect(band).toHaveAttribute("aria-pressed", "true");
    const second = { ...touch, pointerId: 8, isPrimary: false, clientX: 320 };
    fireEvent.pointerDown(band, second);
    expect(band).toHaveAttribute("aria-pressed", "false");
    fireEvent.pointerUp(band, touch);
    fireEvent.pointerUp(band, second);
    fireEvent.click(band);
    act(() => {
      vi.runAllTimers();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(band).toHaveAttribute("aria-pressed", "false");
  });

  it("drops a queued long-press activation if the second finger lands before its click", () => {
    const { band } = mount();
    fireEvent.pointerDown(band, touch);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(onSelect).not.toHaveBeenCalled();
    const second = { ...touch, pointerId: 8, isPrimary: false, clientX: 320 };
    fireEvent.pointerDown(band, second);
    fireEvent.pointerUp(band, touch);
    fireEvent.pointerUp(band, second);
    act(() => {
      vi.runAllTimers();
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(band).toHaveAttribute("aria-pressed", "false");
  });

  it.each(["pointercancel", "unmount"])(
    "drops a queued long-press activation on %s",
    (cancellation) => {
      const { band, unmount } = mount();
      fireEvent.pointerDown(band, touch);
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      if (cancellation === "pointercancel")
        fireEvent.pointerCancel(band, touch);
      else unmount();
      act(() => {
        vi.runAllTimers();
      });
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it("does not let a selected band steal the next direct trim tap", () => {
    const { band, trim } = mount(true);
    fireEvent.pointerDown(band, touch);
    fireEvent.pointerUp(band, touch);
    fireEvent.click(band, { detail: 1 });
    act(() => {
      vi.runAllTimers();
    });
    expect(band).toHaveAttribute("aria-pressed", "true");
    onSelect.mockClear();
    const onTrim = { ...touch, clientX: 252, clientY: 160 };
    fireEvent.pointerDown(trim!, onTrim);
    fireEvent.pointerUp(trim!, onTrim);
    fireEvent.click(trim!, { detail: 1 });
    act(() => {
      vi.runAllTimers();
    });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("trim");
  });
});
