import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import type { NudgeField } from "../../edit/nudge";
import { NUDGE_KINDS } from "../../edit/nudge";
import type { AutomationPoint } from "../../types/project";
import { Button } from "../../ui";
import { BUSY_REASON } from "../../ui/disabledReason";
import { focusAndReveal } from "../../ui/focusAndReveal";
import { focusHeld } from "../../ui/focusHold";
import { isValidFocusTarget } from "../../ui/focusTarget";
import { modalShortcuts } from "../../ui/modalGate";
import { ModifierInspector } from "../ModifierInspector";
import type { useNudgeRun } from "../useNudgeRun";

export type EnvelopeError = {
  target: "time" | "level" | "form";
  message: string;
};

export type EnvelopeForm = {
  kind: "add" | "edit";
  pointId: string;
  time: string;
  level: string;
  notice?: string;
};
export type EnvelopeWorkspaceViewProps = {
  trackId?: string;
  nudgeRun?: ReturnType<typeof useNudgeRun>;
  nudgeActive?: boolean;
  trackName: string;
  points: readonly AutomationPoint[];
  pointId: string | null;
  editable: boolean;
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
  const touchRef = useRef(props.touch);
  touchRef.current = props.touch;
  const formHeading = useRef<HTMLHeadingElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  const priorForm = useRef(form != null);
  const initialFocus = useRef(false);
  const formKind = form?.kind ?? null;
  const controlsBusy = busy || props.nudgeActive === true;
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
    busy || form != null || !editable || nudgeRun?.saving === true;
  return (
    <ModifierInspector
      badge="Volume envelope"
      title={trackName}
      subtitle={editable ? "Editing volume envelope" : "Volume envelope"}
      error={error?.target === "form" ? error.message : null}
      primaryActions={[
        {
          label: "Done",
          disabledReason: controlsBusy ? BUSY_REASON : undefined,
          onClick: props.onDone,
        },
      ]}
    >
      <div
        ref={workspace}
        className="envelope-workspace"
        role="group"
        aria-label="Volume envelope controls"
      >
        {!editable && (
          <p>Volume envelope editing is available to the project owner.</p>
        )}
        <p>
          Time is measured on the timeline. Level multiplies this track’s
          volume: 1.00× is unchanged, 0 is silent, and 1.50× is the maximum.
        </p>
        {points.length === 0 ? (
          <p>
            No volume points. Add a point to control this track’s volume over
            time. A single point sets the level across the whole track.
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
        {pointId && !selected && (
          <p role="status">
            This point is no longer available. Select another point or add one.
          </p>
        )}
        {editable && !form && (
          <div className="envelope-workspace-actions">
            <Button
              ref={add}
              disabledReason={controlsBusy ? BUSY_REASON : undefined}
              onClick={props.onAdd}
            >
              Add point
            </Button>
            {selected && (
              <Button
                disabledReason={controlsBusy ? BUSY_REASON : undefined}
                onClick={props.onEdit}
              >
                Edit point
              </Button>
            )}
            {selected && (
              <Button
                variant="danger"
                disabledReason={controlsBusy ? BUSY_REASON : undefined}
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
              field={{ kind: "envelope-level", trackId, pointId: selected.id }}
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
            <h3 ref={formHeading} tabIndex={-1}>
              {form.kind === "add" ? "Add point" : "Edit point"}
            </h3>
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
                disabledReason={controlsBusy ? BUSY_REASON : undefined}
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
