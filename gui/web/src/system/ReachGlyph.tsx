import { useId, useRef, useState } from "react";
import { useOutsidePointerDown } from "../ui/useOutsidePointerDown";
import { SystemIcon } from "./SystemIcon";

export type LinkReach = "anywhere" | "network";

const COPY: Record<LinkReach, { label: string; text: string }> = {
  anywhere: {
    label: "Reachable from anywhere",
    text: "Anyone with the link can open it, from anywhere.",
  },
  network: {
    label: "Only on this network",
    text: "Only people on this network can open it. Turn on online sharing to reach anyone.",
  },
};

/**
 * The Link row's online-sharing glyph: a filled globe when the link reaches
 * anyone, a slashed one when it works only on this network. Pressing it opens
 * a one-sentence popover with the fix.
 */
export function ReachGlyph({ reach }: { reach: LinkReach }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useOutsidePointerDown({
    liveRefs: [button, panel],
    onOutside: () => setOpen(false),
    enabled: open,
  });
  const copy = COPY[reach];
  return (
    <span className="sys-link-reach" data-reach={reach}>
      <button
        ref={button}
        type="button"
        className="sys-icon-btn"
        aria-label={copy.label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={copy.label}
        onClick={() => setOpen(!open)}
        // Escape closes the popover and nothing under it (the sheet it sits in).
        onKeyDown={(event) => {
          if (!open || event.key !== "Escape") return;
          event.stopPropagation();
          setOpen(false);
        }}
      >
        <SystemIcon
          name={reach === "network" ? "globe-off" : "globe"}
          size={14}
        />
      </button>
      {open ? (
        <div ref={panel} id={id} className="sys-link-popover" role="note">
          {copy.text}
        </div>
      ) : null}
    </span>
  );
}
