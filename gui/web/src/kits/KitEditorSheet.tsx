import {
  type FormEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type {
  KitListRow,
  KitSaveResult,
  SegmentListRow,
  SegmentRow,
} from "../api";
import { useViewportClass } from "../hooks/useViewportClass";
import { Sheet } from "../system/Sheet";
import { Button, Field, InlineError } from "../ui";
import { KitEntryRow } from "./KitEntryRow";
import { KitSegmentPicker } from "./KitSegmentPicker";
import {
  draftReducer,
  EMPTY_DRAFT,
  MAX_ENTRIES,
  startsAfterStart,
  usesOf,
} from "./kitDraft";
import { healthySegments } from "./kitEditorCopy";
import { kitNameProblem, matchKitName, nameHint } from "./kitName";
import { type KitSender, useKitSave } from "./useKitSave";

export const NEW_KIT_LABEL = "New kit";
export const SAVE_KIT_LABEL = "Save kit";
export const ENTRIES_LABEL = "Kit segments";
export const ENTRIES_EMPTY =
  "Add the segments this kit puts on a new episode, in order.";
export const NO_ENTRIES_REASON = "Add at least one segment.";
export const GONE_REASON =
  "Remove the segments that are no longer in the library.";
export const SAVING_TEXT = "Saving the kit…";
export const KIT_HELP =
  "A kit puts these segments on an episode that has none. Each one follows the newest version of its segment.";

type Props = {
  open: boolean;
  onClose: () => void;
  /** The segment library; null while it loads. */
  segments: readonly SegmentListRow[] | null;
  /** The kit library, to say whether the name makes a new kit or the next version. */
  kits: readonly KitListRow[] | null;
  /** Called with the reply after the kit is saved; the sheet closes itself. */
  onSaved: (result: KitSaveResult, name: string, count: number) => void;
  /** The studio said a segment is gone: read the segment library again. */
  onSegmentsChanged?: () => void;
  /** Replaces the request to the studio; stories use it to stand in a reply. */
  send?: KitSender;
};

type Focus =
  | { kind: "move"; uid: number; direction: "up" | "down" }
  | { kind: "remove"; index: number };

function nth(position: number, total: number): string {
  return `position ${position} of ${total}`;
}

export function KitEditorSheet({
  open,
  onClose,
  segments,
  kits,
  onSaved,
  onSegmentsChanged,
  send,
}: Props) {
  const phone = useViewportClass() === "phone";
  const formId = useId();
  const nameField = useRef<HTMLInputElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const focus = useRef<Focus | null>(null);
  const [draft, dispatch] = useReducer(draftReducer, EMPTY_DRAFT);
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  // Spoken here, not as a toast: a toast would sit over Save in the bottom sheet.
  const [spoken, setSpoken] = useState("");
  const { saving, failure, refusal, save, clearFailure } = useKitSave(send);

  // Each open starts from an empty kit.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      dispatch({ type: "reset" });
      setName("");
      setTouched(false);
      setSpoken("");
    }
  }

  const healthy = healthySegments(segments);
  const byId = new Map(healthy.map((row) => [row.id, row]));
  const { entries } = draft;
  const lateStarts = startsAfterStart(entries);
  const entryName = (uid: number): string => {
    const found = entries.find((entry) => entry.uid === uid);
    return found ? (byId.get(found.segmentId)?.name ?? found.segmentId) : "";
  };
  const gone =
    segments !== null && entries.some((entry) => !byId.has(entry.segmentId));
  const problem = kitNameProblem(name);
  const nameError = touched ? problem : null;
  const match = matchKitName(name, kits);
  const full = entries.length >= MAX_ENTRIES;

  let saveReason: string | undefined;
  if (saving) saveReason = SAVING_TEXT;
  else if (entries.length === 0) saveReason = NO_ENTRIES_REASON;
  else if (gone) saveReason = GONE_REASON;

  // After a move or a remove the control that had focus may be disabled or gone.
  useLayoutEffect(() => {
    const want = focus.current;
    if (!want) return;
    focus.current = null;
    if (want.kind === "move") {
      const row = list.current?.querySelector<HTMLElement>(
        `[data-kit-entry="${want.uid}"]`,
      );
      const same = row?.querySelector<HTMLButtonElement>(
        `[data-move="${want.direction}"]`,
      );
      const other = row?.querySelector<HTMLButtonElement>(
        `[data-move="${want.direction === "up" ? "down" : "up"}"]`,
      );
      (same && !same.disabled ? same : other)?.focus();
      return;
    }
    const rows =
      list.current?.querySelectorAll<HTMLElement>("[data-kit-entry]");
    const target = rows?.[Math.min(want.index, rows.length - 1)];
    (
      target?.querySelector<HTMLElement>("[data-remove]") ?? nameField.current
    )?.focus();
  }, [draft]);

  // A refused save leaves the sheet open: put focus where the next step is.
  const wasSaving = useRef(false);
  useEffect(() => {
    if (wasSaving.current && !saving && failure !== null) {
      if (refusal === "kit_name_invalid") nameField.current?.focus();
      else saveButton.current?.focus();
      if (refusal === "kit_segment_missing") onSegmentsChanged?.();
    }
    wasSaving.current = saving;
  }, [saving, failure, refusal, onSegmentsChanged]);

  const add = (segment: SegmentRow) => {
    if (full) return;
    dispatch({ type: "add", segmentId: segment.id, kind: segment.kind });
    clearFailure();
    setSpoken(`Added ${segment.name} at position ${entries.length + 1}.`);
  };

  const move = (uid: number, by: -1 | 1) => {
    const from = entries.findIndex((entry) => entry.uid === uid);
    const to = from + by;
    if (from < 0 || to < 0 || to >= entries.length) return;
    dispatch({ type: "move", uid, by });
    clearFailure();
    focus.current = { kind: "move", uid, direction: by < 0 ? "up" : "down" };
    setSpoken(`Moved ${entryName(uid)} to ${nth(to + 1, entries.length)}.`);
  };

  const remove = (uid: number) => {
    const index = entries.findIndex((entry) => entry.uid === uid);
    const removed = entryName(uid);
    dispatch({ type: "remove", uid });
    clearFailure();
    focus.current = { kind: "remove", index };
    setSpoken(`Removed ${removed} from the kit.`);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    if (problem !== null) {
      setTouched(true);
      nameField.current?.focus();
      return;
    }
    if (saveReason !== undefined) return;
    const trimmed = name.trim();
    const result = await save({
      name: trimmed,
      entries: entries.map((entry) => ({
        segment_id: entry.segmentId,
        at: entry.at,
      })),
    });
    if (result === null) return;
    onSaved(result, trimmed, entries.length);
    onClose();
  };

  const close = () => {
    if (!saving) onClose();
  };

  return (
    <Sheet
      form={phone ? "bottom" : "end"}
      open={open}
      onClose={close}
      title={NEW_KIT_LABEL}
      detent="full"
      initialFocusRef={nameField}
      footer={
        <div className="kit-editor-actions">
          <Button
            onClick={close}
            disabledReason={saving ? SAVING_TEXT : undefined}
          >
            Cancel
          </Button>
          <Button
            ref={saveButton}
            type="submit"
            form={formId}
            variant="primary"
            disabledReason={saveReason}
          >
            {SAVE_KIT_LABEL}
          </Button>
        </div>
      }
    >
      <form
        id={formId}
        className="kit-editor"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <Field
          label="Name"
          hint={problem === null ? nameHint(match) : undefined}
          hintLive
          error={nameError}
        >
          {(control) => (
            <input
              {...control}
              ref={nameField}
              type="text"
              autoComplete="off"
              spellCheck
              readOnly={saving}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                clearFailure();
              }}
              onBlur={() => {
                if (name !== "") setTouched(true);
              }}
            />
          )}
        </Field>
        <p className="kit-problem">{KIT_HELP}</p>
        <section className="kit-editor-section">
          <h3 className="kit-editor-heading">In this kit</h3>
          {entries.length === 0 ? (
            <p className="kit-library-empty">{ENTRIES_EMPTY}</p>
          ) : (
            <ol ref={list} className="kit-entries" aria-label={ENTRIES_LABEL}>
              {entries.map((entry, index) => {
                const earlier = lateStarts.get(entry.uid);
                return (
                  <KitEntryRow
                    key={entry.uid}
                    entry={entry}
                    position={index + 1}
                    total={entries.length}
                    segment={byId.get(entry.segmentId) ?? null}
                    aheadOf={earlier === undefined ? null : entryName(earlier)}
                    disabled={saving}
                    onAt={(at) => {
                      dispatch({ type: "setAt", uid: entry.uid, at });
                      clearFailure();
                    }}
                    onMove={(by) => move(entry.uid, by)}
                    onRemove={() => remove(entry.uid)}
                  />
                );
              })}
            </ol>
          )}
        </section>
        <section className="kit-editor-section">
          <h3 className="kit-editor-heading">Add a segment</h3>
          <KitSegmentPicker
            rows={segments}
            used={(id) => usesOf(entries, id)}
            full={full}
            disabled={saving}
            onAdd={add}
          />
        </section>
        <p className="sr-only" role="status">
          {spoken}
        </p>
        {saving ? (
          <p className="kit-problem" role="status">
            {SAVING_TEXT}
          </p>
        ) : null}
        <InlineError message={failure} />
      </form>
    </Sheet>
  );
}
