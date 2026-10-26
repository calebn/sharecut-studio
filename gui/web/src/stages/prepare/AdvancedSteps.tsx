import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { StatusRow } from "../../system/StatusRow";
import { SystemIcon } from "../../system/SystemIcon";
import { useFocusRescue } from "../../system/useFocusRescue";
import { Button, Menu, MenuItem } from "../../ui";

type ScrubParam = {
  kind: "scrub";
  id: string;
  label: string;
  /** One line shown while the field has focus, and read with it. */
  help: string;
  value: number;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
  /** Singular and plural, so the spoken value is plain: "4 seconds". */
  unit: readonly [singular: string, plural: string];
};

type LanguageParam = {
  kind: "language";
  id: string;
  label: string;
  help: string;
  value: string;
  defaultValue: string;
  options: readonly { value: string; label: string }[];
};

type StepParam = ScrubParam | LanguageParam;

export type AdvancedStep = {
  id: string;
  /** Plain name: "Fill gaps from the recorder's noise gate". */
  name: string;
  /** Last result line: "12 gaps filled". */
  result?: string;
  /** Only optional steps get a switch. */
  optional: boolean;
  enabled: boolean;
  params: readonly StepParam[];
};

export type AdvancedGroup = {
  id: string;
  title: string;
  steps: readonly AdvancedStep[];
};

type RunningStep = {
  title: string;
  detail?: string;
  progress?: number;
};

export type AdvancedStepsProps = {
  groups: readonly AdvancedGroup[];
  /** The step whose settings show. Without it the list shows. */
  selectedId?: string;
  running?: RunningStep;
  onSelect: (id: string) => void;
  onBack: () => void;
  onToggle: (id: string, enabled: boolean) => void;
  onParam: (stepId: string, paramId: string, value: number | string) => void;
  onReset: (stepId: string, paramId: string) => void;
  onRunFromHere: (id: string) => void;
  onCancel: () => void;
};

const BUSY = "Steps cannot change while one is running.";

function clampedValue(param: ScrubParam): number {
  const value = Number.isFinite(param.value) ? param.value : param.defaultValue;
  return Math.min(param.max, Math.max(param.min, value));
}

function valueText(param: ScrubParam): string {
  const [one, many] = param.unit;
  const value = clampedValue(param);
  return `${value} ${value === 1 ? one : many}`;
}

function Help({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="sys-adv-help">
      {children}
    </p>
  );
}

type FieldProps = {
  stepId: string;
  param: StepParam;
  locked: boolean;
  /** Set while a step runs: the visible line that says why nothing changes. */
  busyId?: string;
  onParam: AdvancedStepsProps["onParam"];
  onReset: AdvancedStepsProps["onReset"];
};

function ParamField({
  stepId,
  param,
  locked,
  busyId,
  onParam,
  onReset,
}: FieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const describedBy = busyId ? `${helpId} ${busyId}` : helpId;
  const field = useRef<HTMLDivElement>(null);
  useFocusRescue(
    field,
    () => () => field.current?.querySelector<HTMLElement>("input, select"),
  );
  const shown = param.kind === "scrub" ? clampedValue(param) : param.value;
  const changed = shown !== param.defaultValue;
  const known =
    param.kind === "language" &&
    param.options.some((option) => option.value === param.value);
  return (
    <div ref={field} className="sys-adv-field">
      <div className="sys-adv-field-head">
        <label className="sys-adv-label" htmlFor={id}>
          {param.label}
        </label>
        {param.kind === "scrub" ? (
          <span className="sys-adv-value" aria-hidden="true">
            {valueText(param)}
          </span>
        ) : null}
        {changed ? (
          <button
            type="button"
            className="sys-adv-reset"
            aria-label={`Reset to default: ${param.label}`}
            disabled={locked}
            aria-describedby={locked ? busyId : undefined}
            onClick={() => onReset(stepId, param.id)}
          >
            <span className="sys-adv-reset-dot" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {param.kind === "scrub" ? (
        <input
          id={id}
          type="range"
          className="sys-adv-range"
          min={param.min}
          max={param.max}
          step={param.step}
          value={shown}
          disabled={locked}
          aria-valuetext={valueText(param)}
          aria-describedby={describedBy}
          onChange={(event) =>
            onParam(stepId, param.id, Number(event.target.value))
          }
        />
      ) : (
        <select
          id={id}
          className="sys-adv-select"
          value={param.value}
          disabled={locked}
          aria-describedby={describedBy}
          onChange={(event) => onParam(stepId, param.id, event.target.value)}
        >
          {known ? null : (
            <option value={param.value} disabled>
              {param.value ? `Custom (${param.value})` : "Custom"}
            </option>
          )}
          {param.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
      <Help id={helpId}>{param.help}</Help>
    </div>
  );
}

type SwitchProps = {
  name: string;
  checked: boolean;
  locked: boolean;
  reasonId: string;
  onChange: (checked: boolean) => void;
};

function StepSwitch({
  name,
  checked,
  locked,
  reasonId,
  onChange,
}: SwitchProps) {
  return (
    <input
      type="checkbox"
      role="switch"
      className="sys-adv-switch"
      aria-label={name}
      checked={checked}
      aria-checked={checked}
      disabled={locked}
      aria-describedby={locked ? reasonId : undefined}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

/**
 * The full step list behind "Advanced", and one step's settings in the same
 * panel. Choosing a step moves focus to its heading; Back to steps returns it
 * to the row that opened it. Settings commit on change, with no Apply. Only
 * the steps the Getting ready rows stand for are listed.
 */
export function AdvancedSteps({
  groups,
  selectedId,
  running,
  onSelect,
  onBack,
  onToggle,
  onParam,
  onReset,
  onRunFromHere,
  onCancel,
}: AdvancedStepsProps) {
  const titleId = useId();
  const reasonId = useId();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef(selectedId);
  const locked = running !== undefined;
  const steps = groups.flatMap((group) => group.steps);
  const selected = steps.find((step) => step.id === selectedId);

  useEffect(() => {
    if (shown.current === selectedId) return;
    const before = shown.current;
    shown.current = selectedId;
    if (selectedId) heading.current?.focus();
    else if (before) rows.current.get(before)?.focus();
  }, [selectedId]);

  const status = running ? (
    <div className="sys-adv-running">
      <StatusRow
        state="running"
        title={running.title}
        detail={running.detail}
        progress={running.progress}
        action={{ label: "Cancel", onAction: onCancel }}
      />
      <p id={reasonId} className="sys-adv-reason">
        {BUSY}
      </p>
    </div>
  ) : null;

  if (selected) {
    const off = selected.optional && !selected.enabled;
    return (
      <div className="sys-adv">
        <div className="sys-adv-bar">
          <Button onClick={onBack}>
            <SystemIcon name="chevron-left" size={16} />
            Back to steps
          </Button>
        </div>
        {status}
        <h2 ref={heading} tabIndex={-1} className="sys-adv-title">
          {selected.name}
        </h2>
        {selected.result ? (
          <p className="sys-adv-result">{selected.result}</p>
        ) : null}
        {selected.optional ? (
          <label className="sys-adv-toggle">
            <StepSwitch
              name={selected.name}
              checked={selected.enabled}
              locked={locked}
              reasonId={reasonId}
              onChange={(on) => onToggle(selected.id, on)}
            />
            <span>{selected.enabled ? "On" : "Off"}</span>
          </label>
        ) : null}
        {selected.params.length === 0 ? (
          <p className="sys-adv-result">Nothing to adjust for this step.</p>
        ) : (
          <div className="sys-adv-fields">
            {selected.params.map((param) => (
              <ParamField
                key={param.id}
                stepId={selected.id}
                param={param}
                locked={locked || off}
                busyId={locked ? reasonId : undefined}
                onParam={onParam}
                onReset={onReset}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="sys-adv">
      <h2 id={titleId} className="sys-adv-title">
        Advanced steps
      </h2>
      {status}
      {groups.map((group) => (
        <section
          key={group.id}
          className="sys-adv-group"
          aria-labelledby={`${titleId}-${group.id}`}
        >
          <h3 id={`${titleId}-${group.id}`} className="sys-adv-group-title">
            {group.title}
          </h3>
          <ul className="sys-adv-list">
            {group.steps.map((step) => (
              <li key={step.id} className="sys-adv-row">
                <button
                  type="button"
                  className="sys-adv-open"
                  ref={(node) => {
                    if (node) rows.current.set(step.id, node);
                    else rows.current.delete(step.id);
                  }}
                  onClick={() => onSelect(step.id)}
                >
                  <span className="sys-status-title">{step.name}</span>
                  <span className="sys-status-detail">
                    {step.optional && !step.enabled
                      ? "Off"
                      : (step.result ?? "Not run yet")}
                  </span>
                  <span className="sys-adv-chevron" aria-hidden="true">
                    <SystemIcon name="chevron-down" size={16} />
                  </span>
                </button>
                {step.optional ? (
                  <StepSwitch
                    name={step.name}
                    checked={step.enabled}
                    locked={locked}
                    reasonId={reasonId}
                    onChange={(on) => onToggle(step.id, on)}
                  />
                ) : null}
                <Menu
                  open={menuFor === step.id}
                  onOpenChange={(open) => setMenuFor(open ? step.id : null)}
                  label={`More for ${step.name}`}
                  className="ui-menu-root sys-menu"
                  trigger={(props) => (
                    <Button {...props} aria-label={`More for ${step.name}`}>
                      <SystemIcon name="ellipsis" size={16} />
                    </Button>
                  )}
                >
                  <MenuItem
                    disabledReason={locked ? BUSY : undefined}
                    onSelect={() => {
                      setMenuFor(null);
                      onRunFromHere(step.id);
                    }}
                  >
                    Run again from here
                  </MenuItem>
                </Menu>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
