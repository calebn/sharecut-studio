import { useEffect, useRef } from "react";
import { ModelGateHint, ModelGatePanel } from "../../models";
import { Skeleton } from "../../system/Skeleton";
import { StatusRow } from "../../system/StatusRow";
import { Button, InlineError, SegmentedControl, ToggleButton } from "../../ui";
import { useDisabledReasonNote } from "../../ui/disabledReason";
import {
  BOUNCE_RUNNING_REASON,
  type BounceOptions,
  type BounceSource,
  type BounceState,
  bounceBlocker,
} from "./bounceLogic";
import { DeliverSection } from "./DeliverSection";

type Props = {
  options: BounceOptions;
  state?: "ready" | "loading";
};

const IDLE: BounceState = { phase: "idle" };

const SOURCES: readonly { id: BounceSource; label: string }[] = [
  { id: "entire", label: "Entire mix" },
  { id: "selected", label: "Selected tracks" },
  { id: "soloed", label: "Soloed tracks" },
];

/** A quick mixdown to `export/bounces/`: no mastering, no captions. */
export function BounceSection({ options, state: pageState = "ready" }: Props) {
  const {
    state: run,
    choices,
    onChoices,
    selectedCount,
    soloCount,
    hasRegion,
    fixedRange,
    onClearRange,
    gate,
    blockedReason,
    onBounce,
    onCancel,
    onAgain,
    focusRequested = false,
    onFocused,
  } = options;
  const button = useRef<HTMLButtonElement>(null);
  const gatePanel = useRef<HTMLDivElement>(null);
  const asking = gate?.prompt != null;
  const state = asking ? IDLE : run;
  const running = state.phase === "running";
  const blocker = bounceBlocker(
    choices,
    { selected: selectedCount, soloed: soloCount },
    fixedRange !== undefined,
  );
  const unavailable = blockedReason ?? blocker;
  const reason = useDisabledReasonNote(running ? undefined : unavailable);

  const askPhase = gate?.prompt?.phase ?? null;
  // Focus the prompt when it first appears.
  const asked = askPhase !== null;
  useEffect(() => {
    if (!asked) return;
    const first = gatePanel.current?.querySelector("button");
    first?.scrollIntoView?.({ block: "center" });
    first?.focus();
  }, [asked]);

  useEffect(() => {
    if (!focusRequested) return;
    // A disabled button cannot take focus, so land on the first enabled
    // control in the section; the reason note beside Bounce says why.
    const target = button.current?.disabled
      ? button.current
          .closest("section")
          ?.querySelector<HTMLElement>("button:not(:disabled)")
      : button.current;
    target?.focus();
    target?.scrollIntoView?.({ block: "nearest" });
    onFocused?.();
  }, [focusRequested, onFocused]);

  if (pageState === "loading") {
    return (
      <DeliverSection title="Bounce">
        <Skeleton layout="list" rows={3} />
      </DeliverSection>
    );
  }

  const counts: Record<BounceSource, number | null> = {
    entire: null,
    selected: selectedCount,
    soloed: soloCount,
  };

  return (
    <DeliverSection title="Bounce">
      <p className="dv-note">
        A quick mix of the project, written to export/bounces/ without
        mastering.
      </p>
      {gate?.prompt ? (
        <div ref={gatePanel}>
          <ModelGatePanel gate={gate} />
        </div>
      ) : null}
      {asking ? null : (
        <>
          {fixedRange !== undefined ? (
            <>
              <p className="dv-note">
                Selected range · {fixedRange}. This selection is fixed for this
                bounce.
              </p>
              {onClearRange ? (
                <Button variant="link" onClick={onClearRange}>
                  Bounce the whole mix instead
                </Button>
              ) : null}
            </>
          ) : (
            <div className="dv-field">
              <span className="dv-field-label">Source</span>
              <SegmentedControl label="Source">
                {SOURCES.map(({ id, label }) => (
                  <ToggleButton
                    key={id}
                    quiet
                    pressed={choices.source === id}
                    onClick={() => onChoices({ ...choices, source: id })}
                  >
                    {counts[id] === null ? label : `${label} (${counts[id]})`}
                  </ToggleButton>
                ))}
              </SegmentedControl>
            </div>
          )}
          <div className="dv-chips" role="group" aria-label="Bounce options">
            {fixedRange === undefined ? (
              <ToggleButton
                pressed={choices.limitToRegion && hasRegion}
                disabledReason={
                  hasRegion ? undefined : "No session region set."
                }
                onClick={() =>
                  onChoices({
                    ...choices,
                    limitToRegion: !choices.limitToRegion,
                  })
                }
              >
                Limit to session region
              </ToggleButton>
            ) : null}
            <ToggleButton
              pressed={choices.includeMp3}
              onClick={() =>
                onChoices({ ...choices, includeMp3: !choices.includeMp3 })
              }
            >
              Also write MP3
            </ToggleButton>
          </div>
        </>
      )}

      {state.phase === "running" ? (
        <>
          <StatusRow
            state="running"
            title="Bouncing"
            detail={state.detail}
            progress={state.progress ?? undefined}
            action={{
              label: "Cancel",
              onAction: onCancel,
              disabledReason: state.cancelReason,
            }}
          />
          <p className="dv-note">
            You can leave this page. The bounce keeps going and the status bar
            shows its progress.
          </p>
          {state.cancelError ? (
            <InlineError message={`Cancel failed: ${state.cancelError}`} />
          ) : null}
        </>
      ) : null}
      {state.phase === "failed" ? (
        <>
          <StatusRow
            state="failed"
            title="Bounce failed"
            detail={state.cause}
            action={
              onAgain ? { label: "Try again", onAction: onAgain } : undefined
            }
          />
          {gate ? <ModelGateHint gate={gate} actionLabel="Bounce" /> : null}
        </>
      ) : null}
      {state.phase === "cancelled" ? (
        <StatusRow
          state="needs-you"
          title="Bounce cancelled"
          detail={state.detail}
          action={
            onAgain ? { label: "Bounce again", onAction: onAgain } : undefined
          }
        />
      ) : null}
      {state.phase === "done" ? (
        <StatusRow state="done" title="Bounced" detail={state.summary} />
      ) : null}

      {asking ? null : (
        <div className="dv-primary">
          <Button
            ref={button}
            disabledReason={
              running ? BOUNCE_RUNNING_REASON : (unavailable ?? undefined)
            }
            {...reason.describedBy}
            onClick={onBounce}
          >
            Bounce
          </Button>
          {reason.note}
        </div>
      )}

      {state.phase === "done" || state.phase === "cancelled" ? (
        <ul className="dv-files">
          {state.files.map((name) => (
            <li key={name} className="dv-file">
              <span className="dv-file-name sys-mono">{name}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </DeliverSection>
  );
}
