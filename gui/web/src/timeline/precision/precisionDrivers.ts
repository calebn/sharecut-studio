import { endPreview, showPreview } from "../../document/applyDocumentUpdate";
import { currentDocumentSeq } from "../../document/cursor";
import { revertOptimisticIfUnchanged } from "../../document/optimisticRevert";
import {
  NUDGE_KINDS,
  type NudgeField,
  nudgeAxis,
  nudgeKey,
  previewsAsDraft,
  saveNudge,
  withNudge,
  withNudgeIfUnchanged,
  withNudgeReverted,
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

/** Which driver instance holds each draft preview, so a late commit cannot clear a newer drag's. */
const previewOwner = new Map<string, symbol>();

function nudgeDriver(field: NudgeField, name: string): PrecisionDriver {
  let token: symbol | null = null;
  let origin: ProjectView | null = null;
  let path = "";
  let seq = 0;
  let preview: ProjectView | null = null;
  let value = Number.NaN;
  const asDraft = previewsAsDraft(field);
  const key = nudgeKey(field);
  const end = () => {
    const ended = { from: origin, shown: preview, owner: token };
    origin = null;
    preview = null;
    token = null;
    return ended;
  };
  const revert = (
    from: ProjectView | null,
    shown: ProjectView | null,
    owner: symbol | null,
  ) => {
    if (asDraft) {
      if (!owner || previewOwner.get(key) !== owner) return;
      previewOwner.delete(key);
      const shown = useDawStore.getState().project;
      if (
        from &&
        currentDocumentSeq() <= seq &&
        shown &&
        nudgeAxis(shown, field)?.value === value
      )
        endPreview(key, (p) => withNudgeReverted(p, from, field));
      else endPreview(key);
    } else if (from && shown)
      revertOptimisticIfUnchanged(from, seq, path, shown);
  };
  return {
    begin() {
      const s = useDawStore.getState();
      if (!s.project) return false;
      origin = s.project;
      path = s.projectPath;
      seq = currentDocumentSeq();
      preview = null;
      token = Symbol(key);
      value = nudgeAxis(origin, field)?.value ?? Number.NaN;
      return Number.isFinite(value);
    },
    show(next) {
      if (!origin) return;
      const shown = withNudge(origin, field, next);
      if (asDraft) {
        const from = origin;
        try {
          showPreview(
            key,
            (p) => withNudgeIfUnchanged(p, from, field, next),
            (p) => withNudge(p, field, next),
          );
        } catch {
          // Too many pending drafts: this frame is not shown, so it is not the value to save.
          return;
        }
        if (token) previewOwner.set(key, token);
      } else useDawStore.getState().setProject(shown);
      value = next;
      preview = shown;
    },
    async commit() {
      const { from, shown, owner } = end();
      if (!from || !shown) {
        revert(from, shown, owner);
        return;
      }
      const store = useDawStore.getState();
      try {
        const saved = await saveNudge(
          path,
          from,
          field,
          value,
          () => true,
          () => undefined,
        );
        if (saved) {
          // A queued save keeps the value shown through its own command draft.
          if (asDraft && owner && previewOwner.get(key) === owner) {
            previewOwner.delete(key);
            endPreview(key);
          }
          store.announceStatus(NUDGE_KINDS[field.kind].saved, {
            undo: saved.undo,
          });
        } else {
          revert(from, shown, owner);
        }
      } catch (error) {
        revert(from, shown, owner);
        store.announceStatus(`${name} not saved: ${errorMessage(error)}`, {
          tone: "error",
        });
      }
    },
    cancel() {
      const { from, shown, owner } = end();
      revert(from, shown, owner);
    },
  };
}

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
