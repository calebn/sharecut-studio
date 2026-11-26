import { useMemo, useRef } from "react";
import { usePointerType } from "../hooks/usePointerType";
import type { PresencePerson } from "../presence/presencePeople";
import {
  coveredTicks,
  presenceFlags,
  presenceHitPx,
  visiblePeople,
} from "./presenceMath";
import { rulerStep, rulerTicks } from "./rulerMath";
import { useRem } from "./useRem";

/** What a host does around Presence and Ruler in the stories: the flags, the press area for the pointer in use, and the ruler labels the flags cover. */
export function usePresenceDemo({
  people,
  followed,
  start,
  pxPerSecond,
  width,
  duration,
}: {
  people: readonly PresencePerson[];
  followed?: string | null;
  start: number;
  pxPerSecond: number;
  width: number;
  duration: number;
}) {
  const rem = useRem(useRef(null));
  const hit = presenceHitPx(usePointerType(), rem);
  const flags = useMemo(
    () =>
      presenceFlags(visiblePeople(people, followed), {
        start,
        pxPerSecond,
        width,
        hit,
        rem,
      }),
    [people, followed, start, pxPerSecond, width, hit, rem],
  );
  const covered = useMemo(
    () =>
      coveredTicks(
        rulerTicks(
          start,
          pxPerSecond,
          width,
          rulerStep(pxPerSecond, start + width / pxPerSecond, rem),
          duration,
          rem,
        ),
        flags,
        rem,
      ),
    [start, pxPerSecond, width, duration, flags, rem],
  );
  return { flags, hit, covered };
}
