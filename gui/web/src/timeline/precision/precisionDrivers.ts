/**
 * What a precision drag (#1184) moves: the armed target's own drag, driven
 * by value instead of by pointer.
 *
 * A clip's fade and trim handles register a driver over their drag draft
 * (`useClipEdgeHandles`), so a precision drag shows exactly what a finger
 * drag shows (the edge, the ripple mark or gap, the arrows on every lane)
 * and saves through the same `saveClipEdge`, cut-speech question included.
 * A pending edge or an envelope point's time previews and saves as a held
 * strip nudge does (`edit/nudge.ts`), the same commands its drag runs.
 */
import { currentDocumentSeq } from "../../document/cursor";
import { revertOptimisticIfUnchanged } from "../../document/optimisticRevert";
import {
  NUDGE_KINDS,
  type NudgeField,
  nudgeAxis,
  saveNudge,
  withNudge,
} from "../../edit/nudge";
import { useDawStore } from "../../state/dawStore";
import type { ProjectView } from "../../types/project";
import { errorMessage } from "../../utils/apiError";

export interface PrecisionDriver {
  /** Starts a draft at the saved value; false when it cannot edit now. */
  begin(): boolean;
  /** Previews `value` (field units). */
  show(value: number): void;
  /** Saves the last value shown, as one undoable edit. */
  commit(): Promise<void>;
  /** Drops the draft, saving nothing. */
  cancel(): void;
}

const registered = new Map<string, PrecisionDriver>();

/** The key a timeline target's driver registers under. */
export function driverKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

export function registerPrecisionDriver(
  key: string,
  driver: PrecisionDriver,
): () => void {
  registered.set(key, driver);
  return () => {
    if (registered.get(key) === driver) registered.delete(key);
  };
}

function nudgeDriver(field: NudgeField, name: string): PrecisionDriver {
  let origin: ProjectView | null = null;
  let path = "";
  let seq = 0;
  let preview: ProjectView | null = null;
  let value = Number.NaN;
  /** Ends the draft; returns what it began from and showed last. */
  const end = () => {
    const ended = { from: origin, shown: preview };
    origin = null;
    preview = null;
    return ended;
  };
  const revert = (from: ProjectView | null, shown: ProjectView | null) => {
    if (from && shown) revertOptimisticIfUnchanged(from, seq, path, shown);
  };
  return {
    begin() {
      const s = useDawStore.getState();
      if (!s.project) return false;
      origin = s.project;
      path = s.projectPath;
      seq = currentDocumentSeq();
      preview = null;
      value = nudgeAxis(origin, field)?.value ?? Number.NaN;
      return Number.isFinite(value);
    },
    show(next) {
      if (!origin) return;
      value = next;
      preview = withNudge(origin, field, next);
      useDawStore.getState().setProject(preview);
    },
    async commit() {
      const { from, shown } = end();
      if (!from || !shown) return;
      const store = useDawStore.getState();
      try {
        if (await saveNudge(path, from, field, value)) {
          store.announceStatus(NUDGE_KINDS[field.kind].saved);
        } else {
          revert(from, shown);
        }
      } catch (error) {
        revert(from, shown);
        store.announceStatus(`${name} not saved: ${errorMessage(error)}`);
      }
    },
    cancel() {
      const { from, shown } = end();
      revert(from, shown);
    },
  };
}

/** The driver for target `kind`/`id`, whose time value is `field`. */
export function precisionDriver(
  kind: string,
  id: string,
  field: NudgeField,
  name: string,
): PrecisionDriver | null {
  if (field.kind === "fade" || field.kind === "trim") {
    return registered.get(driverKey(kind, id)) ?? null;
  }
  return nudgeDriver(field, name);
}
