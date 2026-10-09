import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  auditionBoundary,
  type BoundaryContext,
  type BoundaryEdit,
  type BoundaryGeometryClip,
  type BoundaryTarget,
  boundaryAudioUrl,
  loadBoundaryContext,
} from "../api/boundary";
import { expandGhostSourceRange } from "../edit/ghostPreview";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import type { EditBoundaryView } from "../types/project";
import { Button, Dialog, InlineError } from "../ui";
import { errorMessage } from "../utils/apiError";

type State =
  | { kind: "loading" }
  | { kind: "load-error"; message: string; stale: boolean }
  | {
      kind: "editing";
      context: BoundaryContext;
      value: number;
      preview: "idle" | "preparing" | "ready";
      pair: Awaited<ReturnType<typeof auditionBoundary>> | null;
      saveError: string | null;
      stale: boolean;
    }
  | { kind: "saving"; context: BoundaryContext; value: number }
  | { kind: "queued"; context: BoundaryContext; value: number };

type Props = {
  open: boolean;
  onClose: () => void;
  projectPath: string;
  target: BoundaryTarget;
  expectedGeometry: BoundaryGeometryClip[];
  boundary: EditBoundaryView;
  contextNote?: string;
  onApply: (
    edit: BoundaryEdit,
    expectedToken: string,
  ) => Promise<{ queued: boolean }>;
};

function editFor(
  target: BoundaryTarget,
  offsetSec: number,
  currentSourceSec: number,
): BoundaryEdit {
  return target.kind === "roll"
    ? { ...target, delta_sec: offsetSec }
    : { ...target, source_sec: currentSourceSec + offsetSec, mode: "ripple" };
}

function editValue(edit: BoundaryEdit, currentSourceSec: number): number {
  return edit.kind === "roll"
    ? edit.delta_sec
    : edit.source_sec - currentSourceSec;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function offsetLimits(context: BoundaryContext): { min: number; max: number } {
  const shift = context.target.kind === "trim" ? context.current.source_sec : 0;
  return { min: context.limits.min - shift, max: context.limits.max - shift };
}

function offsetInputValid(
  input: string,
  context: BoundaryContext | null,
): boolean {
  if (!context || input.trim() === "") return false;
  const value = Number(input);
  const limits = offsetLimits(context);
  return (
    Number.isFinite(value) &&
    value >= limits.min &&
    value <= limits.max &&
    Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-8
  );
}

function seconds(value: number): string {
  return `${value.toFixed(3)} s`;
}

function isStale(error: unknown): boolean {
  return error instanceof Error && /409|stale|changed/i.test(error.message);
}

function ghostCoverage(
  words: EditBoundaryView["cutaway_word_ids"],
  range: { start: number; end: number } | null,
): { full: string[]; partial: string[] } {
  const full: string[] = [];
  const partial: string[] = [];
  if (!range) return { full, partial };
  for (const word of words) {
    const wordEnd = word.end <= word.start ? word.start + 0.001 : word.end;
    const overlaps = wordEnd > range.start && word.start < range.end;
    if (!overlaps) continue;
    if (range.start <= word.start && range.end >= wordEnd) full.push(word.text);
    else partial.push(word.text);
  }
  return { full, partial };
}

export function PrecisionBoundaryDialog({
  open,
  onClose,
  projectPath,
  target,
  expectedGeometry,
  boundary,
  contextNote,
  onApply,
}: Props) {
  const targetKey = JSON.stringify(target);
  const stableTarget = useMemo(
    () => JSON.parse(targetKey) as BoundaryTarget,
    [targetKey],
  );
  const expectedGeometryKey = JSON.stringify(expectedGeometry);
  const stableExpectedGeometry = useMemo(
    () => JSON.parse(expectedGeometryKey) as BoundaryGeometryClip[],
    [expectedGeometryKey],
  );
  const [state, setState] = useState<State>({ kind: "loading" });
  const [inputValue, setInputValue] = useState("0");
  const stateRef = useRef(state);
  stateRef.current = state;
  const mounted = useRef(false);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const ownerId = useId();
  const valueId = useId();
  const openingEpoch = useRef(useDawStore.getState().projectEpoch);
  const { guestMode, projectEpoch } = useDaw((s) => ({
    guestMode: s.guestMode,
    projectEpoch: s.projectEpoch,
  }));
  const previewError = useDaw((s) =>
    s.sourcePreview?.ownerId === ownerId ? s.sourcePreviewError : null,
  );

  useEffect(() => {
    if (!previewError || previewError.kind !== "unavailable") return;
    setState((current) =>
      current.kind === "editing" && current.pair
        ? { ...current, preview: "idle", pair: null }
        : current,
    );
  }, [previewError]);

  const valid = useCallback(
    () =>
      mounted.current &&
      useDawStore.getState().projectPath === projectPath &&
      useDawStore.getState().projectEpoch === openingEpoch.current &&
      useDawStore.getState().projectEpoch === projectEpoch,
    [projectEpoch, projectPath],
  );

  const loadContext = useCallback(
    (signal: AbortSignal) =>
      loadBoundaryContext(
        projectPath,
        stableTarget,
        stableExpectedGeometry,
        signal,
      ),
    [projectPath, stableExpectedGeometry, stableTarget],
  );

  const stopPreview = useCallback(() => {
    generation.current += 1;
    request.current?.abort();
    request.current = null;
    useDawStore.getState().releaseSourcePreview(ownerId);
  }, [ownerId]);

  useEffect(() => {
    if (!open) return;
    mounted.current = true;
    openingEpoch.current = projectEpoch;
    stopPreview();
    const loadGeneration = generation.current;
    if (guestMode) {
      setState({
        kind: "load-error",
        message: "Precision boundary audition is available in the host editor.",
        stale: false,
      });
      return () => {
        mounted.current = false;
        stopPreview();
      };
    }
    const controller = new AbortController();
    request.current = controller;
    setState({ kind: "loading" });
    void loadContext(controller.signal)
      .then((context) => {
        if (
          !valid() ||
          controller.signal.aborted ||
          generation.current !== loadGeneration
        )
          return;
        setState({
          kind: "editing",
          context,
          value: 0,
          preview: "idle",
          pair: null,
          saveError: null,
          stale: false,
        });
        setInputValue("0");
      })
      .catch((error: unknown) => {
        if (
          !valid() ||
          controller.signal.aborted ||
          generation.current !== loadGeneration
        )
          return;
        setState({
          kind: "load-error",
          message: errorMessage(error),
          stale: isStale(error),
        });
      });
    return () => {
      mounted.current = false;
      controller.abort();
      stopPreview();
    };
  }, [
    open,
    projectPath,
    projectEpoch,
    guestMode,
    loadContext,
    stopPreview,
    valid,
  ]);

  const changeValue = (next: number, preserveInput = false) => {
    const current = stateRef.current;
    if (current.kind !== "editing" || !Number.isFinite(next)) return;
    stopPreview();
    const limits = offsetLimits(current.context);
    const clamped = clamp(
      Math.round(next * 1000) / 1000,
      limits.min,
      limits.max,
    );
    if (!preserveInput) setInputValue(String(clamped));
    setState({
      ...current,
      value: clamped,
      preview: "idle",
      pair: null,
      saveError: null,
      stale: false,
    });
  };

  const listen = async (choice: "current" | "proposed") => {
    const current = stateRef.current;
    if (
      current.kind !== "editing" ||
      current.preview === "preparing" ||
      !offsetInputValid(inputValue, current.context) ||
      !valid()
    )
      return;
    if (current.preview === "ready" && current.pair) {
      stopPreview();
      const window = current.pair[choice];
      useDawStore.getState().beginSourcePreview({
        ownerId,
        media: {
          kind: "rendered",
          url: boundaryAudioUrl(window.url, current.pair.token),
        },
        startSec: 0,
        endSec: window.duration_sec,
      });
      setState(current);
      return;
    }
    stopPreview();
    const requestGeneration = generation.current;
    const controller = new AbortController();
    request.current = controller;
    setState({ ...current, preview: "preparing", pair: null, saveError: null });
    try {
      const pair = await auditionBoundary(
        projectPath,
        target,
        editFor(target, current.value, current.context.current.source_sec),
        current.context.token,
        controller.signal,
      );
      if (
        !valid() ||
        controller.signal.aborted ||
        generation.current !== requestGeneration ||
        stateRef.current.kind !== "editing" ||
        stateRef.current.value !== current.value
      )
        return;
      const actualValue = editValue(
        pair.actual_edit,
        current.context.current.source_sec,
      );
      const window = pair[choice];
      useDawStore.getState().beginSourcePreview({
        ownerId,
        media: {
          kind: "rendered",
          url: boundaryAudioUrl(window.url, pair.token),
        },
        startSec: 0,
        endSec: window.duration_sec,
      });
      setState({
        ...current,
        context: { ...current.context, token: pair.token },
        value: actualValue,
        preview: "ready",
        pair,
        saveError: null,
        stale: false,
      });
    } catch (error) {
      if (
        !valid() ||
        controller.signal.aborted ||
        generation.current !== requestGeneration
      )
        return;
      setState({
        ...current,
        preview: "idle",
        pair: null,
        saveError: errorMessage(error),
        stale: isStale(error),
      });
    } finally {
      if (request.current === controller) request.current = null;
    }
  };

  const apply = async () => {
    const current = stateRef.current;
    if (
      current.kind !== "editing" ||
      !offsetInputValid(inputValue, current.context) ||
      !valid()
    )
      return;
    stopPreview();
    if (current.value === 0) {
      onClose();
      return;
    }
    setState({
      kind: "saving",
      context: current.context,
      value: current.value,
    });
    try {
      const result = await onApply(
        editFor(target, current.value, current.context.current.source_sec),
        current.context.token,
      );
      if (valid()) {
        if (result.queued)
          setState({
            kind: "queued",
            context: current.context,
            value: current.value,
          });
        else onClose();
      }
    } catch (error) {
      if (!valid()) return;
      setState({
        ...current,
        preview: "idle",
        pair: null,
        saveError: errorMessage(error),
        stale: isStale(error),
      });
    }
  };

  const reload = () => {
    stopPreview();
    const loadGeneration = generation.current;
    setState({ kind: "loading" });
    const controller = new AbortController();
    request.current = controller;
    void loadContext(controller.signal)
      .then((nextContext) => {
        if (
          !valid() ||
          controller.signal.aborted ||
          generation.current !== loadGeneration
        )
          return;
        setState({
          kind: "editing",
          context: nextContext,
          value: 0,
          preview: "idle",
          pair: null,
          saveError: null,
          stale: false,
        });
        setInputValue("0");
      })
      .catch((error: unknown) => {
        if (
          valid() &&
          !controller.signal.aborted &&
          generation.current === loadGeneration
        )
          setState({
            kind: "load-error",
            message: errorMessage(error),
            stale: isStale(error),
          });
      });
  };

  const title = "Adjust boundary";
  const saving = state.kind === "saving";
  const context =
    state.kind === "editing" ||
    state.kind === "saving" ||
    state.kind === "queued"
      ? state.context
      : null;
  const value =
    state.kind === "editing" ||
    state.kind === "saving" ||
    state.kind === "queued"
      ? state.value
      : null;
  const label = target.kind === "roll" ? "Roll join" : `Trim ${target.edge}`;
  const currentSource = context?.current.source_sec;
  const proposedSource =
    context && value != null ? context.current.source_sec + value : null;
  const words = boundary.cutaway_word_ids;
  const geometryFor = (id: string) =>
    context?.geometry.find((clip) => clip.id === id);
  const rollLeft =
    target.kind === "roll" ? geometryFor(target.left_clip_id) : null;
  const rollRight =
    target.kind === "roll" ? geometryFor(target.right_clip_id) : null;
  const editDelta = context && value != null ? value : 0;
  const ghostRange =
    context && value != null
      ? expandGhostSourceRange({
          kind: target.kind,
          deltaSec: editDelta,
          ...(target.kind === "trim" ? { edge: target.edge } : {}),
          leftSourceEnd:
            target.kind === "roll"
              ? (rollLeft?.source_end ?? boundary.cutaway_source_start)
              : context.current.source_sec,
          rightSourceStart:
            target.kind === "roll"
              ? (rollRight?.source_start ?? boundary.cutaway_source_end)
              : context.current.source_sec,
        })
      : null;
  const coverage = ghostCoverage(words, ghostRange);
  const limits = context ? offsetLimits(context) : null;
  const inputValid = offsetInputValid(inputValue, context);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      panelClassName="precision-boundary-dialog"
      closeDisabled={saving}
    >
      {state.kind === "queued" ? (
        <div className="precision-boundary-queued">
          <p role="status">
            Boundary change queued for sync. It will apply when the host
            reconnects.
          </p>
          <Button onClick={onClose}>Close</Button>
        </div>
      ) : state.kind === "loading" ? (
        <p role="status">Preparing boundary controls…</p>
      ) : state.kind === "load-error" ? (
        <div className="precision-boundary-error">
          <InlineError message={state.message} />
          {state.stale ? (
            <Button onClick={reload}>Reload boundary</Button>
          ) : null}
        </div>
      ) : context && value != null ? (
        <div className="precision-boundary-content">
          {contextNote ? (
            <p className="precision-boundary-context-note">{contextNote}</p>
          ) : null}
          <p className="precision-boundary-operation">{label}</p>
          <label htmlFor={valueId}>
            {target.kind === "roll"
              ? "Change join by (seconds)"
              : "Change boundary by (seconds)"}
          </label>
          <div className="precision-boundary-number">
            <Button
              aria-label="Adjust by minus 1 millisecond"
              disabled={
                saving ||
                (state.kind === "editing" && state.preview === "preparing")
              }
              onClick={() => changeValue(value - context.limits.fine_step_sec)}
            >
              −1 ms
            </Button>
            <input
              id={valueId}
              type="number"
              min={limits?.min}
              max={limits?.max}
              step={context.limits.fine_step_sec}
              value={inputValue}
              aria-invalid={state.kind === "editing" && !inputValid}
              disabled={saving}
              onChange={(event) => {
                setInputValue(event.currentTarget.value);
                const next = event.currentTarget.valueAsNumber;
                if (Number.isFinite(next)) changeValue(next, true);
                else {
                  stopPreview();
                  setState((current) =>
                    current.kind === "editing"
                      ? {
                          ...current,
                          preview: "idle",
                          pair: null,
                          saveError: null,
                        }
                      : current,
                  );
                }
              }}
            />
            <Button
              aria-label="Adjust by plus 1 millisecond"
              disabled={
                saving ||
                (state.kind === "editing" && state.preview === "preparing")
              }
              onClick={() => changeValue(value + context.limits.fine_step_sec)}
            >
              +1 ms
            </Button>
          </div>
          <div
            className="precision-boundary-nudges"
            aria-label="Regular adjustments"
          >
            <Button
              aria-label="Adjust by minus 10 milliseconds"
              disabled={saving}
              onClick={() =>
                changeValue(value - context.limits.regular_step_sec)
              }
            >
              −10 ms
            </Button>
            <Button
              aria-label="Adjust by plus 10 milliseconds"
              disabled={saving}
              onClick={() =>
                changeValue(value + context.limits.regular_step_sec)
              }
            >
              +10 ms
            </Button>
          </div>
          <p className="precision-boundary-range">
            Allowed offset: {seconds(limits?.min ?? 0)} to{" "}
            {seconds(limits?.max ?? 0)}
          </p>
          <dl className="precision-boundary-positions">
            <div>
              <dt>Current source position</dt>
              <dd>{seconds(currentSource ?? 0)}</dd>
            </div>
            <div>
              <dt>Current timeline seam</dt>
              <dd>{seconds(context.current.timeline_sec)}</dd>
            </div>
            <div>
              <dt>Proposed source position</dt>
              <dd>{seconds(proposedSource ?? 0)}</dd>
            </div>
            {state.kind === "editing" && state.pair ? (
              <div>
                <dt>Proposed timeline seam</dt>
                <dd>
                  {seconds(
                    state.pair.proposed.window_start_sec +
                      state.pair.proposed.seam_offset_sec,
                  )}
                </dd>
              </div>
            ) : null}
          </dl>
          {coverage.full.length + coverage.partial.length > 0 ? (
            <div className="precision-boundary-ghost" role="status">
              <p>
                {coverage.full.length === words.length &&
                coverage.partial.length === 0
                  ? "All cutaway word spans are fully restored."
                  : `${coverage.full.length} word spans fully restored; ${coverage.partial.length} touched in part.`}
              </p>
              <ul>
                {coverage.full.map((word) => (
                  <li key={`full:${word}`}>
                    <q>{word}</q> — full source span
                  </li>
                ))}
                {coverage.partial.map((word) => (
                  <li key={`partial:${word}`}>
                    <q>{word}</q> — partial source span
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {state.kind === "editing" && state.saveError ? (
            <div className="precision-boundary-error">
              <InlineError message={state.saveError} />
              {state.stale ? (
                <Button onClick={reload}>Reload boundary</Button>
              ) : null}
            </div>
          ) : null}
          {state.kind === "editing" && previewError ? (
            <InlineError message={previewError.message} />
          ) : null}
          {state.kind === "editing" && !inputValid ? (
            <InlineError
              message={`Enter a whole-millisecond offset from ${seconds(limits?.min ?? 0)} to ${seconds(limits?.max ?? 0)} to audition or apply.`}
            />
          ) : null}
          <h3 className="precision-boundary-audition-title">
            Listen to this track
          </h3>
          {state.kind === "editing" && state.preview === "preparing" ? (
            <p role="status">Preparing current and proposed audio…</p>
          ) : null}
          {state.kind === "editing" &&
          state.preview === "ready" &&
          state.pair ? (
            <p role="status">
              This track audition · current seam{" "}
              {seconds(
                state.pair.current.window_start_sec +
                  state.pair.current.seam_offset_sec,
              )}{" "}
              · proposed seam{" "}
              {seconds(
                state.pair.proposed.window_start_sec +
                  state.pair.proposed.seam_offset_sec,
              )}
            </p>
          ) : null}
          <div className="precision-boundary-audition">
            <Button
              disabled={
                !inputValid ||
                saving ||
                (state.kind === "editing" && state.preview === "preparing")
              }
              onClick={() => void listen("current")}
            >
              Listen current
            </Button>
            <Button
              disabled={
                !inputValid ||
                saving ||
                (state.kind === "editing" && state.preview === "preparing")
              }
              onClick={() => void listen("proposed")}
            >
              Listen proposed
            </Button>
          </div>
          <div className="precision-boundary-actions">
            <Button disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!inputValid || saving || state.kind !== "editing"}
              onClick={() => void apply()}
            >
              {saving ? "Saving boundary…" : "Apply"}
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
