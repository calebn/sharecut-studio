import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { NudgeField } from "../../edit/nudge";
import { NUDGE_KINDS } from "../../edit/nudge";
import type { EnvelopeForm } from "../../state/types";
import type { AutomationPoint } from "../../types/project";
import { Button } from "../../ui";
import { SheetHeaderContent } from "../../ui/BottomSheet";
import { useSheetHeader } from "../../ui/BottomSheetHeader";
import { BUSY_REASON } from "../../ui/disabledReason";
import { focusAndReveal } from "../../ui/focusAndReveal";
import { focusHeld } from "../../ui/focusHold";
import { isValidFocusTarget } from "../../ui/focusTarget";
import { modalShortcuts } from "../../ui/modalGate";
import { ModifierInspector } from "../ModifierInspector";
import type { useNudgeRun } from "../useNudgeRun";
import { usePhoneEnvelopeSheet } from "../usePhoneEnvelopeSheet";

export type EnvelopeError = {
  target: "time" | "level" | "form";
  message: string;
};

export type EnvelopeWorkspaceViewProps = {
  trackId?: string;
  nudgeRun?: ReturnType<typeof useNudgeRun>;
  nudgeActive?: boolean;
  trackName: string;
  points: readonly AutomationPoint[];
  pointId: string | null;
  editable: boolean;
  levelsVisible: boolean;
  form: EnvelopeForm | null;
  busy: boolean;
  error: EnvelopeError | null;
  collisionId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onEdit: () => void;
  onChange: (form: EnvelopeForm) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onReload: () => void;
  onDone: () => void;
  onToggleLevels: () => void;
  /** Touch input: opening the form must not raise the software keyboard. */
  touch?: boolean;
};

function NudgeRow({
  field,
  value,
  label,
  run,
  disabled,
}: {
  field: NudgeField;
  value: number;
  label: string;
  run: ReturnType<typeof useNudgeRun>;
  disabled: boolean;
}) {
  const kind = NUDGE_KINDS[field.kind];
  const [small, large] = kind.steps;
  const deltas =
    field.kind === "envelope-level"
      ? [-small, small]
      : [-large, -small, small, large];
  const unit = field.kind === "envelope-time" ? "ms" : kind.unit;
  return (
    <div className="nudge-row envelope-nudge-row">
      <span className="nudge-row-reading">
        <span className="nudge-row-label">{label}</span>
        <output className="nudge-row-value">
          {field.kind === "envelope-time"
            ? `${value.toFixed(3)} s`
            : `${value.toFixed(2)}×`}
        </output>
      </span>
      <div
        className="nudge-row-buttons"
        role="group"
        aria-label={`Nudge envelope ${label.toLowerCase()}`}
      >
        {deltas.map((delta) => (
          <button
            key={delta}
            type="button"
            className="ui-control nudge-button"
            aria-label={`${field.kind === "envelope-time" ? Math.round(Math.abs(delta) * 1000) : Math.abs(delta)} ${unit} ${kind.ways[delta < 0 ? 0 : 1]}`}
            disabled={
              disabled ||
              (field.kind === "envelope-level" && value === 0 && delta < 0)
            }
            {...run.buttonProps(
              field,
              delta,
              `Envelope point ${label.toLowerCase()}`,
            )}
          >
            {delta < 0 ? "−" : "+"}
            {field.kind === "envelope-time"
              ? Math.round(Math.abs(delta) * 1000)
              : Math.abs(delta)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function EnvelopeWorkspaceView(props: EnvelopeWorkspaceViewProps) {
  const {
    trackName,
    points,
    pointId,
    editable,
    levelsVisible,
    form,
    busy,
    error,
    collisionId,
    trackId,
    nudgeRun,
  } = props;
  const id = useId();
  const workspace = useRef<HTMLDivElement>(null);
  const timeInput = useRef<HTMLInputElement>(null);
  const sheet = useSheetHeader();
  const compact = sheet?.shortPhone === true;
  const [helpOpen, setHelpOpen] = useState(false);
  usePhoneEnvelopeSheet(workspace, trackId, sheet?.root ?? null);
  const touchRef = useRef(props.touch);
  useLayoutEffect(() => {
    touchRef.current = props.touch;
  }, [props.touch]);
  const formHeading = useRef<HTMLHeadingElement>(null);
  const compactTitle = useRef<HTMLHeadingElement>(null);
  const inspectorTitle = useRef<HTMLHeadingElement>(null);
  const ordinaryDone = useRef<HTMLButtonElement>(null);
  const compactDone = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<{
    from: "compact" | "ordinary";
    role: "heading" | "done" | "help";
    element: HTMLElement;
  } | null>(null);
  const ordinaryHeadingRef = useCallback((node: HTMLHeadingElement | null) => {
    if (!node) return;
    formHeading.current = node;
    return () => {
      if (node.ownerDocument.activeElement === node)
        pendingFocus.current = {
          from: "ordinary",
          role: "heading",
          element: node,
        };
      if (formHeading.current === node) formHeading.current = null;
    };
  }, []);
  const compactHeadingRef = useCallback((node: HTMLHeadingElement | null) => {
    if (!node) return;
    formHeading.current = node;
    compactTitle.current = node;
    return () => {
      if (node.ownerDocument.activeElement === node)
        pendingFocus.current = {
          from: "compact",
          role: "heading",
          element: node,
        };
      if (formHeading.current === node) formHeading.current = null;
      if (compactTitle.current === node) compactTitle.current = null;
    };
  }, []);
  const ordinaryDoneRef = useCallback((node: HTMLButtonElement | null) => {
    if (!node) return;
    ordinaryDone.current = node;
    return () => {
      if (node.ownerDocument.activeElement === node)
        pendingFocus.current = {
          from: "ordinary",
          role: "done",
          element: node,
        };
      if (ordinaryDone.current === node) ordinaryDone.current = null;
    };
  }, []);
  const compactDoneRef = useCallback((node: HTMLButtonElement | null) => {
    if (!node) return;
    compactDone.current = node;
    return () => {
      if (node.ownerDocument.activeElement === node)
        pendingFocus.current = { from: "compact", role: "done", element: node };
      if (compactDone.current === node) compactDone.current = null;
    };
  }, []);
  const compactHelpRef = useCallback((node: HTMLButtonElement | null) => {
    if (!node) return;
    return () => {
      if (node.ownerDocument.activeElement === node)
        pendingFocus.current = { from: "compact", role: "help", element: node };
    };
  }, []);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    pendingFocus.current = null;
    if (!pending || pending.from === (compact ? "compact" : "ordinary")) return;
    const active = pending.element.ownerDocument.activeElement;
    if (
      active !== pending.element &&
      active !== pending.element.ownerDocument.body
    )
      return;
    if (pending.role !== "done" && !form) return;
    let target: HTMLElement | null =
      pending.role === "done"
        ? compact
          ? compactDone.current
          : ordinaryDone.current
        : formHeading.current;
    if (pending.role === "done" && !isValidFocusTarget(target))
      target = form
        ? formHeading.current
        : compact
          ? compactTitle.current
          : inspectorTitle.current;
    if (isValidFocusTarget(target)) focusAndReveal(target);
  });
  const select = useRef<HTMLSelectElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  const priorForm = useRef(form != null);
  const initialFocus = useRef(false);
  const formKind = form?.kind ?? null;
  const controlsBusy = busy || props.nudgeActive === true;
  const pointDisabledReason = controlsBusy
    ? BUSY_REASON
    : levelsVisible
      ? undefined
      : "Show the volume envelope before changing points.";
  useEffect(() => {
    const returningFromForm = priorForm.current && !formKind;
    priorForm.current = formKind != null;
    if (formKind || returningFromForm) {
      initialFocus.current = true;
      focusAndReveal(
        formKind
          ? touchRef.current
            ? formHeading.current
            : timeInput.current
          : points.length
            ? select.current
            : add.current,
      );
      return;
    }
    if (initialFocus.current) return;
    const view = workspace.current;
    const previous = document.activeElement;
    const frame = requestAnimationFrame(() => {
      if (view !== workspace.current) return;
      initialFocus.current = true;
      if (!isValidFocusTarget(view)) return;
      const active = document.activeElement;
      if (
        focusHeld(document) ||
        modalShortcuts() !== null ||
        (active !== previous && active !== document.body)
      )
        return;
      const target = points.length ? select.current : add.current;
      if (isValidFocusTarget(target) && view.contains(target))
        focusAndReveal(target);
    });
    return () => cancelAnimationFrame(frame);
  }, [formKind, points.length]);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (
      error &&
      active instanceof HTMLElement &&
      workspace.current?.contains(active)
    ) {
      focusAndReveal(active);
    }
  }, [error]);
  const cancelOnEscape = (
    event: Pick<KeyboardEvent, "key" | "preventDefault" | "stopPropagation">,
  ) => {
    if (event.key === "Escape" && form && !controlsBusy) {
      event.preventDefault();
      event.stopPropagation();
      props.onCancel();
    }
  };
  const selected = points.find((point) => point.id === pointId);
  const nudgeDisabled =
    busy ||
    form != null ||
    !editable ||
    !levelsVisible ||
    nudgeRun?.saving === true;
  return (
    <ModifierInspector
      ref={inspectorTitle}
      badge="Volume envelope"
      title={trackName}
      subtitle={editable ? "Editing volume envelope" : "Volume envelope"}
      error={error?.target === "form" ? error.message : null}
      primaryActions={
        compact
          ? []
          : [
              {
                label: "Done",
                ref: ordinaryDoneRef,
                disabledReason: controlsBusy ? BUSY_REASON : undefined,
                onClick: props.onDone,
              },
            ]
      }
    >
      {compact && (
        <SheetHeaderContent
          title={
            <h2 ref={compactHeadingRef} tabIndex={-1}>
              {form
                ? `${form.kind === "add" ? "Add" : "Edit"} point · ${trackName}`
                : `Volume envelope · ${trackName}`}
            </h2>
          }
        >
          {form && (
            <Button
              ref={compactHelpRef}
              aria-label="Volume envelope help"
              aria-expanded={helpOpen}
              aria-controls={`${id}-context`}
              onClick={() => setHelpOpen(!helpOpen)}
            >
              Help
            </Button>
          )}
          <Button
            ref={compactDoneRef}
            disabledReason={controlsBusy ? BUSY_REASON : undefined}
            onClick={props.onDone}
          >
            Done
          </Button>
        </SheetHeaderContent>
      )}
      <div
        ref={workspace}
        className={`envelope-workspace${compact ? " envelope-workspace--short" : ""}`}
        role="group"
        aria-label="Volume envelope controls"
      >
        <div
          id={`${id}-context`}
          className="envelope-workspace-context"
          hidden={compact && form !== null && !helpOpen}
        >
          <Button
            aria-pressed={levelsVisible}
            disabledReason={controlsBusy ? BUSY_REASON : undefined}
            onClick={props.onToggleLevels}
          >
            {levelsVisible ? "Hide volume envelope" : "Show volume envelope"}
          </Button>
          {!levelsVisible && (
            <p role="status">
              The volume envelope is hidden. Show it before adding, editing, or
              deleting points.
            </p>
          )}
          {!editable && (
            <p>This link can view, but not edit, the volume envelope.</p>
          )}
          <p className="envelope-workspace-help">
            Time is measured on the timeline. Level multiplies this track’s
            volume: 1.00× is unchanged, 0 is silent, and 1.50× is the maximum.
          </p>
          {points.length === 0 ? (
            <p className="envelope-workspace-help">
              No volume points. Add points to control this track’s volume over
              time. The first point preserves the prior level at the timeline
              ends.
            </p>
          ) : (
            <label htmlFor={`${id}-point`}>
              Envelope point
              <select
                id={`${id}-point`}
                ref={select}
                onFocus={(event) => focusAndReveal(event.currentTarget)}
                value={selected?.id ?? ""}
                disabled={controlsBusy || form != null}
                onChange={(event) => props.onSelect(event.target.value)}
              >
                <option value="" disabled>
                  Select a point
                </option>
                {points.map((point, index) => (
                  <option key={point.id} value={point.id}>
                    Point {index + 1} · {point.time} seconds · {point.value}×
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {pointId && !selected && (
          <p role="status">
            This point is no longer available. Select another point or add one.
          </p>
        )}
        {editable && !form && (
          <div className="envelope-workspace-actions">
            <Button
              ref={add}
              disabledReason={pointDisabledReason}
              onClick={props.onAdd}
            >
              Add point
            </Button>
            {selected && (
              <Button
                disabledReason={pointDisabledReason}
                onClick={props.onEdit}
              >
                Edit point
              </Button>
            )}
            {selected && (
              <Button
                variant="danger"
                disabledReason={pointDisabledReason}
                onClick={props.onDelete}
              >
                {points.length === 1
                  ? "Remove volume envelope"
                  : "Delete point"}
              </Button>
            )}
          </div>
        )}
        {selected && points.length === 1 && editable && !form && (
          <p>
            Removing this envelope returns automation to 1.00×. Track volume and
            effects stay unchanged.
          </p>
        )}
        {selected && !form && trackId && nudgeRun && (
          <section
            className="envelope-numeric-controls"
            aria-label="Selected envelope point values"
          >
            <NudgeRow
              field={{ kind: "envelope-time", trackId, pointId: selected.id }}
              value={selected.time}
              label="Time"
              run={nudgeRun}
              disabled={nudgeDisabled}
            />
            <NudgeRow
              field={{
                kind: "envelope-level",
                trackId,
                pointId: selected.id,
              }}
              value={selected.value}
              label="Level"
              run={nudgeRun}
              disabled={nudgeDisabled}
            />
          </section>
        )}
        {form && (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              props.onSave();
            }}
          >
            {!compact && (
              <h3 ref={ordinaryHeadingRef} tabIndex={-1}>
                {form.kind === "add" ? "Add point" : "Edit point"}
              </h3>
            )}
            {form.notice && <p>{form.notice}</p>}
            <label htmlFor={`${id}-time`}>
              Time (seconds on timeline)
              <input
                ref={timeInput}
                id={`${id}-time`}
                aria-invalid={error?.target === "time" || undefined}
                aria-describedby={
                  error?.target === "time" ? `${id}-time-error` : undefined
                }
                onKeyDown={cancelOnEscape}
                type="text"
                inputMode="decimal"
                onFocus={(event) => focusAndReveal(event.currentTarget)}
                value={form.time}
                disabled={controlsBusy}
                onChange={(event) =>
                  props.onChange({ ...form, time: event.target.value })
                }
              />
            </label>
            {error?.target === "time" && (
              <p id={`${id}-time-error`} role="alert">
                {error.message}
              </p>
            )}
            <label htmlFor={`${id}-level`}>
              Level (×)
              <input
                id={`${id}-level`}
                aria-invalid={error?.target === "level" || undefined}
                aria-describedby={
                  error?.target === "level" ? `${id}-level-error` : undefined
                }
                onKeyDown={cancelOnEscape}
                type="text"
                inputMode="decimal"
                onFocus={(event) => focusAndReveal(event.currentTarget)}
                value={form.level}
                disabled={controlsBusy}
                onChange={(event) =>
                  props.onChange({ ...form, level: event.target.value })
                }
              />
            </label>
            {error?.target === "level" && (
              <p id={`${id}-level-error`} role="alert">
                {error.message}
              </p>
            )}
            <div className="envelope-workspace-actions">
              <Button
                type="submit"
                variant="primary"
                disabledReason={pointDisabledReason}
                onKeyDown={cancelOnEscape}
              >
                Save point
              </Button>
              <Button
                disabledReason={controlsBusy ? BUSY_REASON : undefined}
                onClick={props.onCancel}
                onKeyDown={cancelOnEscape}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {busy && <p role="status">Saving volume envelope…</p>}
        {error && !busy && (
          <div className="envelope-workspace-actions">
            {collisionId && (
              <Button onClick={() => props.onSelect(collisionId)}>
                Discard draft and select existing point
              </Button>
            )}
            <Button onClick={props.onReload}>
              Discard draft and reload points
            </Button>
          </div>
        )}
      </div>
    </ModifierInspector>
  );
}
