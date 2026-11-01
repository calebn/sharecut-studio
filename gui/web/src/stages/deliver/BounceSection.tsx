import { useEffect, useLayoutEffect, useRef } from "react";
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

function seedNativeAnchor(section: HTMLElement): (() => void) | null {
  const page = section.closest<HTMLElement>(".dv-page");
  const stage = page?.closest<HTMLElement>(".dv-stage");
  if (!page || !stage) return null;
  const previous = new Map<HTMLElement, { value: string; priority: string }>();
  let branch = section;
  while (branch !== page && branch.parentElement) {
    const parent = branch.parentElement;
    for (const sibling of parent.children) {
      if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
      previous.set(sibling, {
        value: sibling.style.getPropertyValue("overflow-anchor"),
        priority: sibling.style.getPropertyPriority("overflow-anchor"),
      });
      sibling.style.setProperty("overflow-anchor", "none");
    }
    branch = parent;
  }
  let active = true;
  const inputs = ["pointerdown", "wheel", "touchstart", "keydown"] as const;
  const release = () => {
    if (!active) return;
    active = false;
    page.removeEventListener("scroll", release, true);
    for (const type of inputs) stage.removeEventListener(type, release, true);
    stage.removeEventListener("focusin", leaveSection, true);
    stage.removeEventListener("focusout", leaveStage, true);
    for (const [element, prior] of previous) {
      if (
        element.style.getPropertyValue("overflow-anchor") !== "none" ||
        element.style.getPropertyPriority("overflow-anchor") !== ""
      )
        continue;
      if (prior.value)
        element.style.setProperty(
          "overflow-anchor",
          prior.value,
          prior.priority,
        );
      else element.style.removeProperty("overflow-anchor");
    }
    previous.clear();
  };
  const leaveSection = (event: FocusEvent) => {
    if (
      event.target instanceof Node &&
      event.target !== stage &&
      !section.contains(event.target)
    )
      release();
  };
  const leaveStage = (event: FocusEvent) => {
    if (
      event.relatedTarget instanceof Node &&
      !stage.contains(event.relatedTarget)
    )
      release();
  };
  page.addEventListener("scroll", release, { capture: true, passive: true });
  for (const type of inputs)
    stage.addEventListener(type, release, { capture: true, passive: true });
  stage.addEventListener("focusin", leaveSection, true);
  stage.addEventListener("focusout", leaveStage, true);
  return release;
}

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
    rangeIsRunning = false,
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
  const clearRange = useRef<HTMLButtonElement>(null);
  const anchor = useRef<{ release: () => void; sawRunning: boolean } | null>(
    null,
  );
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

  const releaseAnchor = () => {
    anchor.current?.release();
    anchor.current = null;
  };
  const startBounce = () => {
    releaseAnchor();
    const section = button.current?.closest<HTMLElement>("section");
    const release = section ? seedNativeAnchor(section) : null;
    if (release) anchor.current = { release, sawRunning: false };
    onBounce();
  };
  useLayoutEffect(
    () => () => {
      anchor.current?.release();
      anchor.current = null;
    },
    [],
  );
  useLayoutEffect(() => {
    const current = anchor.current;
    if (!current) return;
    if (running) current.sawRunning = true;
    else if (
      current.sawRunning ||
      state.phase !== "idle" ||
      asking ||
      pageState === "loading"
    )
      releaseAnchor();
  });

  useEffect(() => {
    if (!asking) return;
    const first = gatePanel.current?.querySelector("button");
    first?.scrollIntoView?.({ block: "center" });
    first?.focus();
  }, [asking]);

  useEffect(() => {
    if (!focusRequested) return;
    const section = button.current?.closest("section");
    const rangePreservingFocusTarget = button.current?.disabled
      ? Array.from(
          section?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [],
        ).find((el) => el !== clearRange.current)
      : button.current;
    rangePreservingFocusTarget?.focus();
    rangePreservingFocusTarget?.scrollIntoView?.({ block: "nearest" });
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
                Selected range · {fixedRange}. This selection is fixed for{" "}
                {running && !rangeIsRunning ? "the next bounce" : "this bounce"}
                .
              </p>
              {onClearRange ? (
                <Button ref={clearRange} variant="link" onClick={onClearRange}>
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
            onClick={startBounce}
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
