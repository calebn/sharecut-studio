import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import type { AutomationPoint } from "../../types/project";
import { Button } from "../../ui";
import { focusAndReveal } from "../../ui/focusAndReveal";
import { ModifierInspector } from "../ModifierInspector";

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
};

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
  } = props;
  const id = useId();
  const workspace = useRef<HTMLDivElement>(null);
  const timeInput = useRef<HTMLInputElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  const priorForm = useRef(form != null);
  const initialFocus = useRef(false);
  const formKind = form?.kind ?? null;
  useEffect(() => {
    if (!initialFocus.current && !formKind) {
      focusAndReveal(points.length ? select.current : add.current);
    }
    initialFocus.current = true;
    if (formKind) focusAndReveal(timeInput.current);
    else if (priorForm.current)
      focusAndReveal(points.length ? select.current : add.current);
    priorForm.current = formKind != null;
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
  const cancelOnEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && form && !busy) {
      event.preventDefault();
      event.stopPropagation();
      props.onCancel();
    }
  };
  const selected = points.find((point) => point.id === pointId);
  return (
    <ModifierInspector
      badge="Volume envelope"
      title={trackName}
      subtitle={editable ? "Editing volume envelope" : "Volume envelope"}
      error={error?.target === "form" ? error.message : null}
      primaryActions={[
        { label: "Done", disabled: busy, onClick: props.onDone },
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
              disabled={busy || form != null}
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
            <Button ref={add} disabled={busy} onClick={props.onAdd}>
              Add point
            </Button>
            {selected && (
              <Button disabled={busy} onClick={props.onEdit}>
                Edit point
              </Button>
            )}
            {selected && (
              <Button variant="danger" disabled={busy} onClick={props.onDelete}>
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
        {form && (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              props.onSave();
            }}
          >
            <h3>{form.kind === "add" ? "Add point" : "Edit point"}</h3>
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
                disabled={busy}
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
                disabled={busy}
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
                disabled={busy}
                onKeyDown={cancelOnEscape}
              >
                Save point
              </Button>
              <Button
                disabled={busy}
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
