import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  loadWordTimingContext,
  saveWordTiming,
  type WordTimingContext,
} from "../api/transcriptTiming";
import { currentDocumentSeq } from "../document/cursor";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { WaveformLayer } from "../timeline/WaveformLayer";
import type { ProjectView, TranscriptWordView } from "../types/project";
import { Button, CommandButton, InlineError } from "../ui";
import { useResizeObserver } from "../ui/useResizeObserver";
import { errorMessage } from "../utils/apiError";

type Bounds = { start: number; end: number };
type Editor =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready" | "saving";
      context: WordTimingContext;
      draft: Bounds;
      message: string;
    };
type Saved = { project: ProjectView | null; seq: number };

function SourceProgress({
  ownerId,
  start,
  end,
}: {
  ownerId: string;
  start: number;
  end: number;
}) {
  const { position, error } = useDaw((s) => ({
    position:
      s.sourcePreview?.ownerId === ownerId ? s.sourcePreviewPositionSec : null,
    error: s.sourcePreview?.ownerId === ownerId ? s.sourcePreviewError : null,
  }));
  return (
    <>
      {position != null && (
        <span
          className="wordbar-progress"
          style={
            {
              "--wordbar-position": `${Math.max(0, Math.min(100, ((position - start) / (end - start)) * 100))}%`,
            } as CSSProperties
          }
        />
      )}
      {error && <InlineError message={error} role="alert" />}
    </>
  );
}

export function TranscriptWordbar({
  word,
  trackId,
  wordIndex,
}: {
  word: TranscriptWordView;
  trackId: string;
  wordIndex: number;
}) {
  const { projectPath, request } = useDaw((s) => ({
    projectPath: s.projectPath,
    request: s.transcriptTimingRequest,
  }));
  const open =
    request?.projectPath === projectPath &&
    request.trackId === trackId &&
    request.wordIndex === wordIndex;
  if (!word.timing_target) return null;
  return (
    <section className="transcript-wordbar" aria-label="Word timing">
      <CommandButton
        commandId="transcript.adjustTiming"
        args={{ trackId, wordIndex }}
      >
        Adjust timing
      </CommandButton>
      {open && (
        <TimingEditor
          key={JSON.stringify([
            projectPath,
            word.timing_target.track_id,
            word.timing_target.source_id,
            word.timing_target.word_index,
          ])}
          projectPath={projectPath}
          word={word}
        />
      )}
    </section>
  );
}

function TimingEditor({
  projectPath,
  word,
}: {
  projectPath: string;
  word: TranscriptWordView;
}) {
  const [state, setState] = useState<Editor>({ kind: "loading" });
  const [saved, setSaved] = useState<Saved | null>(null);
  const [listen, setListen] = useState(false);
  const [width, setWidth] = useState(1);
  const ownerId = useId();
  const id = useId();
  const mounted = useRef(true);
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  const initialWord = useRef(word);
  const gesture = useRef<{ pointerId: number; before: Bounds } | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const edge = useRef<keyof Bounds>("start");
  const busy = useRef(false);
  const frame = useRef<HTMLDivElement>(null);
  const { project, epoch } = useDaw((s) => ({
    project: s.project,
    epoch: s.projectEpoch,
  }));
  const openingEpoch = useRef(epoch);
  const valid = () =>
    mounted.current &&
    useDawStore.getState().projectPath === projectPath &&
    useDawStore.getState().projectEpoch === openingEpoch.current;
  useResizeObserver(frame, (entries) =>
    setWidth(entries[0]?.contentRect.width ?? 1),
  );
  const stopPreview = () => {
    if (previewTimer.current != null) clearTimeout(previewTimer.current);
    previewTimer.current = null;
    useDawStore.getState().releaseSourcePreview(ownerId);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (previewTimer.current != null) clearTimeout(previewTimer.current);
      useDawStore.getState().releaseSourcePreview(ownerId);
    };
  }, [ownerId]);
  const reload = async (currentWord = initialWord.current) => {
    if (!currentWord.timing_target) return;
    setState({ kind: "loading" });
    try {
      const context = await loadWordTimingContext(
        projectPath,
        currentWord.timing_target,
        currentWord,
      );
      if (valid())
        setState({
          kind: "ready",
          context,
          draft: { start: context.word.start, end: context.word.end },
          message: "",
        });
    } catch (error) {
      if (valid()) setState({ kind: "error", message: errorMessage(error) });
    }
  };
  const initialize = useEffectEvent(() => {
    void reload();
  });
  useEffect(() => {
    initialize();
  }, []);
  const preview = (boundary?: keyof Bounds) => {
    const latest = stateRef.current;
    if (latest.kind !== "ready" || !valid()) return;
    const { context, draft } = latest;
    const duration = context.media.duration_sec;
    if (duration == null) return;
    const center = boundary ? draft[boundary] : null;
    const start = Math.max(
      0,
      center == null ? draft.start - 0.15 : center - 0.18,
    );
    const end = Math.min(
      duration,
      center == null ? draft.end + 0.15 : center + 0.18,
    );
    if (!(end > start)) return;
    useDawStore.getState().beginSourcePreview({
      ownerId,
      trackId: context.target.track_id,
      sourceId: context.target.source_id,
      cacheKey: context.media.cache_key,
      startSec: start,
      endSec: end,
    });
  };
  const change = (field: keyof Bounds, value: number) => {
    const latest = stateRef.current;
    if (latest.kind !== "ready") return;
    const draft = { ...latest.draft, [field]: value };
    const next = { ...latest, draft, message: "" };
    if (!gesture.current && Number.isFinite(value))
      next.context = {
        ...latest.context,
        window: {
          start: Math.max(
            0,
            Math.min(latest.context.window.start, value - 0.25),
          ),
          end: Math.min(
            latest.context.media.duration_sec ?? Infinity,
            Math.max(latest.context.window.end, value + 0.25),
          ),
        },
      };
    stateRef.current = next;
    setState(next);
    edge.current = field;
    if (listen && previewTimer.current == null) {
      const generation = useDawStore.getState().sourcePreviewGeneration;
      previewTimer.current = setTimeout(() => {
        previewTimer.current = null;
        if (generation === useDawStore.getState().sourcePreviewGeneration)
          preview(edge.current);
      }, 250);
    }
  };
  const cancel = () => {
    stopPreview();
    const latest = stateRef.current;
    if (latest.kind !== "ready") return;
    const next = {
      ...latest,
      draft: gesture.current?.before ?? {
        start: latest.context.word.start,
        end: latest.context.word.end,
      },
      message: "Timing adjustment cancelled.",
    };
    gesture.current = null;
    stateRef.current = next;
    setState(next);
  };
  const apply = async () => {
    const latest = stateRef.current;
    if (latest.kind !== "ready" || busy.current || !valid()) return;
    stopPreview();
    gesture.current = null;
    const minimum = latest.context.media.sample_rate
      ? 1 / latest.context.media.sample_rate
      : 0.001;
    if (
      latest.context.media.duration_sec == null ||
      !Number.isFinite(latest.draft.start) ||
      !Number.isFinite(latest.draft.end) ||
      latest.draft.start < 0 ||
      latest.draft.end > latest.context.media.duration_sec ||
      latest.draft.end - latest.draft.start < minimum - 1e-12
    )
      return;
    if (
      latest.draft.start === latest.context.word.start &&
      latest.draft.end === latest.context.word.end
    )
      return;
    busy.current = true;
    setState({ ...latest, kind: "saving" });
    try {
      const result = await saveWordTiming(
        projectPath,
        latest.context,
        latest.draft.start,
        latest.draft.end,
      );
      if (!valid()) return;
      if (result.queued) {
        setState({
          kind: "error",
          message:
            "Timing is queued. Wait for synchronization before reopening.",
        });
        return;
      }
      setSaved(
        typeof result.server_seq === "number" &&
          result.server_seq === currentDocumentSeq()
          ? { project: useDawStore.getState().project, seq: result.server_seq }
          : null,
      );
      const context = await loadWordTimingContext(
        projectPath,
        latest.context.target,
        { ...latest.context.word, ...latest.draft },
      );
      if (valid())
        setState({
          kind: "ready",
          context,
          draft: { start: context.word.start, end: context.word.end },
          message: "Timing saved. One Undo restores both boundaries.",
        });
    } catch (error) {
      if (valid()) setState({ kind: "error", message: errorMessage(error) });
      else
        useDawStore.getState().setTranscriptInlineEditFailure({
          projectPath,
          trackId: latest.context.target.track_id,
          wordIndex: latest.context.target.word_index,
          originalText: latest.context.word.text,
          message: `Could not adjust timing for “${latest.context.word.text}”: ${errorMessage(error)}`,
        });
    } finally {
      busy.current = false;
    }
  };
  const cancelOnEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && stateRef.current.kind === "ready") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };
  const viewport = useMemo(() => ({ scrollLeft: 0, width }), [width]);
  if (state.kind === "loading")
    return <p role="status">Loading source timing…</p>;
  if (state.kind === "error")
    return (
      <>
        <InlineError message={state.message} role="alert" />
        <Button onClick={() => void reload(word)}>Reload timing</Button>
      </>
    );
  const { context, draft } = state;
  const duration = context.media.duration_sec;
  const step = context.media.sample_rate
    ? 1 / context.media.sample_rate
    : 0.001;
  const validBounds =
    duration != null &&
    Number.isFinite(draft.start) &&
    Number.isFinite(draft.end) &&
    draft.start >= 0 &&
    draft.end <= duration &&
    draft.end - draft.start >= step - 1e-12;
  const disabled = state.kind === "saving" || duration == null;
  const changed =
    draft.start !== context.word.start || draft.end !== context.word.end;
  const window = context.window;
  const previous = context.neighbors.find(
    (n) => n.word_index === context.target.word_index - 1,
  );
  const next = context.neighbors.find(
    (n) => n.word_index === context.target.word_index + 1,
  );
  return (
    <div
      role="group"
      aria-label="Adjust source timing"
      className="wordbar-editor"
    >
      <p>
        Source recording · {context.target.source_id ?? context.target.track_id}{" "}
        · seconds
      </p>
      <div className="wordbar-waveform" ref={frame}>
        <WaveformLayer
          mediaRef={context.media.ref}
          kind="raw"
          mediaStartSec={window.start}
          clipLeftCss={0}
          clipWidthCss={width}
          zoom={width / (window.end - window.start)}
          colorVar="var(--clip-dialogue-0)"
          role={
            project?.tracks.find(
              (track) => track.id === context.target.track_id,
            )?.role ?? "dialogue"
          }
          gainDb={0}
          viewport={viewport}
        />
        {(["start", "end"] as const).map((boundary) => (
          <span
            key={boundary}
            className="wordbar-boundary-mark"
            style={
              {
                "--wordbar-position": `${Math.max(0, Math.min(100, ((draft[boundary] - window.start) / (window.end - window.start)) * 100))}%`,
              } as CSSProperties
            }
          />
        ))}
        <SourceProgress
          ownerId={ownerId}
          start={window.start}
          end={window.end}
        />
      </div>
      <div className="wordbar-neighbors" aria-label="Neighboring words">
        {context.neighbors
          .filter(
            (neighbor) =>
              neighbor.end >= window.start && neighbor.start <= window.end,
          )
          .map((neighbor) => (
            <span
              key={neighbor.word_index}
              title={`${neighbor.start.toFixed(3)}–${neighbor.end.toFixed(3)} source seconds`}
              style={
                {
                  "--wordbar-position": `${Math.max(0, Math.min(100, ((neighbor.start - window.start) / (window.end - window.start)) * 100))}%`,
                } as CSSProperties
              }
            >
              {neighbor.text}
            </span>
          ))}
      </div>
      {(["start", "end"] as const).map((field) => (
        <div key={field} className="wordbar-boundary">
          <label htmlFor={`${id}-${field}`}>
            {field === "start" ? "Word start" : "Word end"}
          </label>
          <input
            onKeyDown={cancelOnEscape}
            id={`${id}-${field}`}
            type="range"
            min={window.start}
            max={window.end}
            step={step}
            value={Number.isFinite(draft[field]) ? draft[field] : window.start}
            disabled={disabled}
            aria-valuetext={`${draft[field].toFixed(3)} source seconds`}
            onChange={(event) =>
              change(field, event.currentTarget.valueAsNumber)
            }
            onPointerDown={(event) => {
              gesture.current = {
                pointerId: event.pointerId,
                before: { ...draft },
              };
            }}
            onPointerUp={(event) => {
              if (gesture.current?.pointerId !== event.pointerId) return;
              gesture.current = null;
              void apply();
            }}
            onPointerCancel={cancel}
            onLostPointerCapture={() => {
              if (gesture.current) cancel();
            }}
          />
          <input
            onKeyDown={cancelOnEscape}
            type="number"
            aria-label={`${field === "start" ? "Start" : "End"} source seconds`}
            min={0}
            max={duration ?? undefined}
            step={step}
            value={Number.isFinite(draft[field]) ? draft[field] : ""}
            disabled={disabled}
            onChange={(event) =>
              change(field, event.currentTarget.valueAsNumber)
            }
          />
        </div>
      ))}
      <p className="ui-field-hint">
        Drag a boundary to save on release. Use Apply timing for keyboard or
        numeric changes. Escape cancels the draft.
      </p>
      {(previous && draft.start < previous.end) ||
      (next && draft.end > next.start) ? (
        <p role="status">
          This word overlaps a neighboring word. Other word boundaries stay as
          they are.
        </p>
      ) : null}
      {context.word.ignored || context.transcript_gate ? (
        <p className="ui-field-hint">
          Timing also changes{" "}
          {context.word.ignored
            ? "the ignored audio interval"
            : "the transcript audio gate"}
          ; processed audio will need to refresh.
        </p>
      ) : null}
      {duration == null ? (
        <p role="status">
          Recording duration is unavailable. Wait for its waveform, then reload
          timing.
        </p>
      ) : !validBounds ? (
        <p role="status">Choose a positive span within the recording.</p>
      ) : null}
      <label>
        <input
          onKeyDown={cancelOnEscape}
          type="checkbox"
          checked={listen}
          disabled={disabled}
          onChange={(event) => {
            setListen(event.target.checked);
            if (!event.target.checked) stopPreview();
          }}
        />{" "}
        Listen while adjusting
      </label>
      <p className="ui-field-hint">
        Preview keeps the timeline in place until you stop it or close timing.
      </p>
      <div className="wordbar-actions">
        <Button
          onKeyDown={cancelOnEscape}
          disabled={disabled || !validBounds}
          onClick={() => preview()}
        >
          Play draft
        </Button>
        <Button onKeyDown={cancelOnEscape} onClick={stopPreview}>
          Stop preview
        </Button>
        <Button
          onKeyDown={cancelOnEscape}
          disabled={disabled || !validBounds || !changed}
          onClick={() => void apply()}
        >
          Apply timing
        </Button>
        <Button
          onKeyDown={cancelOnEscape}
          disabled={state.kind === "saving"}
          onClick={cancel}
        >
          Cancel draft
        </Button>
        {saved && (
          <CommandButton
            commandId="history.undo"
            disabled={
              project !== saved.project || currentDocumentSeq() !== saved.seq
            }
            onKeyDown={cancelOnEscape}
            onClick={(event) => {
              const current = useDawStore.getState();
              if (
                current.project !== saved.project ||
                currentDocumentSeq() !== saved.seq
              ) {
                event.preventDefault();
                setSaved(null);
                return;
              }
              stopPreview();
              current.setTranscriptTimingRequest(null);
            }}
          >
            Undo timing
          </CommandButton>
        )}
        <Button
          onKeyDown={cancelOnEscape}
          disabled={state.kind === "saving"}
          onClick={() => {
            stopPreview();
            void reload(word);
          }}
        >
          Reload timing
        </Button>
        <Button
          onKeyDown={cancelOnEscape}
          disabled={state.kind === "saving"}
          onClick={() => {
            stopPreview();
            useDawStore.getState().setTranscriptTimingRequest(null);
          }}
        >
          Close timing
        </Button>
      </div>
      <p role="status">{state.message}</p>
    </div>
  );
}
