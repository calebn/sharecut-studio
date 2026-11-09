import {
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ToggleButton } from "../ui";
import { useResizeObserver } from "../ui/useResizeObserver";
import { AbAudition } from "./AbAudition";
import { ActionBar } from "./ActionBar";
import type { AuditionSide } from "./auditionWindow";
import type { InspectorBounds, InspectorRect } from "./inspectorSheetMath";
import { ScrubField, type ScrubFieldProps } from "./ScrubField";
import { TimeField } from "./TimeField";

export function LiveScrub(props: ScrubFieldProps) {
  const [committed, setCommitted] = useState(props.value);
  const [shown, setShown] = useState(props.value);
  return (
    <ScrubField
      {...props}
      value={shown}
      onPreview={setShown}
      onCommit={(next) => {
        setCommitted(next);
        setShown(next);
      }}
      onCancel={() => setShown(committed)}
    />
  );
}

export function LiveAb({ note }: { note: string }) {
  const [side, setSide] = useState<AuditionSide>("B");
  return (
    <AbAudition
      side={side}
      change={{ start: 0, end: 0 }}
      note={note}
      shortcuts={false}
      onSelect={setSide}
    />
  );
}

export function LiveTime({ label, start }: { label: string; start: number }) {
  const [value, setValue] = useState(start);
  return (
    <TimeField label={label} value={value} step={0.1} onChange={setValue} />
  );
}

export function Mute() {
  const [muted, setMuted] = useState(false);
  return (
    <ToggleButton pressed={muted} onClick={() => setMuted((was) => !was)}>
      Mute
    </ToggleButton>
  );
}

export function Wave() {
  const bars = Array.from({ length: 48 }, (_, i) => {
    const level = 0.25 + 0.6 * Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.23));
    return (
      <span
        key={i}
        style={{
          flex: 1,
          blockSize: `${Math.round(level * 100)}%`,
          background: "var(--color-accent)",
        }}
      />
    );
  });
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-0)",
        inlineSize: "100%",
        blockSize: "7.5rem",
        background: "var(--color-timeline-well)",
      }}
      role="img"
      aria-label="Word waveform, static demo"
    >
      {bars}
    </div>
  );
}

const frame: CSSProperties = {
  position: "relative",
  blockSize: "100dvh",
  overflow: "hidden",
  background: "var(--color-bg-base)",
};

export function Framed({
  children,
}: {
  children: (bounds: InspectorBounds) => ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<InspectorBounds | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (el) setBounds({ width: el.clientWidth, height: el.clientHeight });
  }, []);
  useResizeObserver(box, (entries) => {
    const last = entries[entries.length - 1];
    if (last)
      setBounds({
        width: Math.floor(last.contentRect.width),
        height: Math.floor(last.contentRect.height),
      });
  });
  return (
    <div ref={box} style={frame} data-testid="inspector-frame">
      {bounds ? children(bounds) : null}
    </div>
  );
}

export function AnchorMark({ anchor }: { anchor: InspectorRect }) {
  return (
    <div
      data-testid="inspector-anchor"
      style={{
        position: "absolute",
        insetInlineStart: anchor.x,
        insetBlockStart: anchor.y,
        inlineSize: anchor.width,
        blockSize: anchor.height,
        background: "var(--color-accent-subtle)",
        border: "var(--space-0) solid var(--color-accent)",
        borderRadius: "var(--radius-md)",
      }}
    />
  );
}

export function DemoDock() {
  return (
    <ActionBar
      placement={{ form: "dock" }}
      items={[{ id: "hear" }, { id: "keep" }, { id: "comment" }]}
      onVerb={() => {}}
    />
  );
}
