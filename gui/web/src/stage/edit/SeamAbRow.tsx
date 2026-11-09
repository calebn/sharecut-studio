import { useLayoutEffect, useRef } from "react";
import { AbAudition } from "../../system/AbAudition";
import type { AuditionSide } from "../../system/auditionWindow";
import { note } from "./sheetNote";
import { AB_PREPARING_NOTE } from "./useSeamAudition";

const AB_NOTE = "1.5 s before and after";

export function SeamAbRow({
  reason,
  side,
  pending,
  joinSec,
  onSelect,
}: {
  reason: string | null;
  side: AuditionSide;
  pending: boolean;
  joinSec: number;
  onSelect: (side: AuditionSide) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const held = useRef(false);
  useLayoutEffect(() => {
    if (reason && held.current && document.activeElement === document.body) {
      held.current = false;
      box.current?.focus();
    }
  }, [reason]);
  return (
    <div
      ref={box}
      tabIndex={-1}
      onFocus={() => {
        held.current = reason === null;
      }}
      onBlur={(event) => {
        if (event.relatedTarget) held.current = false;
      }}
    >
      {reason ? (
        note(reason)
      ) : (
        <AbAudition
          side={side}
          change={{ start: joinSec, end: joinSec }}
          note={pending ? AB_PREPARING_NOTE : AB_NOTE}
          shortcuts={false}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}
