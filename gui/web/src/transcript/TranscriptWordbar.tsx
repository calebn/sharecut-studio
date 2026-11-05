import {
  type CSSProperties,
  type PointerEvent,
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
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { ScrubField } from "../system/ScrubField";
import { WaveformLayer } from "../timeline/WaveformLayer";
import type { TranscriptWordView } from "../types/project";
import { Button, InlineError } from "../ui";
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
      {error && <InlineError message={error.message} />}
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
  const projectPath = useDaw((s) => s.projectPath);
  if (!word.timing_target) return null;
  return (
    <section className="transcript-wordbar" aria-label="Word timing">
      <TimingEditor
        key={JSON.stringify([
          projectPath,
          trackId,
          word.timing_target.source_id,
          word.timing_target.word_index,
          wordIndex,
        ])}
        projectPath={projectPath}
        word={word}
      />
    </section>
  );
}

const HANDLE_NAMES = { start: "Word start", end: "Word end" } as const;

function TimingEditor({
  projectPath,
  word,
}: {
  projectPath: string;
  word: TranscriptWordView;
}) {
  const [state, setState] = useState<Editor>({ kind: "loading" });
  const [width, setWidth] = useState(1);
  const ownerId = useId();
  const mounted = useRef(true);
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  const initialWord = useRef(word);
  const gesture = useRef<{ pointerId: number; before: Bounds } | null>(null);
  const busy = useRef(false);
  const frame = useRef<HTMLDivElement>(null);
  const { project, epoch, hearing } = useDaw((s) => ({
    project: s.project,
    epoch: s.projectEpoch,
    hearing: s.sourcePreview?.ownerId === ownerId,
  }));
  const openingEpoch = useRef(epoch);
  const valid = () =>
    mounted.current &&
    useDawStore.getState().projectPath === projectPath &&
    useDawStore.getState().projectEpoch === openingEpoch.current;
  useResizeObserver(frame, (entries) =>
    setWidth(entries[0]?.contentRect.width ?? 1),
  );
  const stopPreview = () =>
    useDawStore.getState().releaseSourcePreview(ownerId);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
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
  const hear = () => {
    const latest = stateRef.current;
    if (latest.kind !== "ready" || !valid()) return;
    const { context, draft } = latest;
    const duration = context.media.duration_sec;
    if (duration == null) return;
    const start = Math.max(0, draft.start - 0.15);
    const end = Math.min(duration, draft.end + 0.15);
    if (!(end > start)) return;
    useDawStore.getState().beginSourcePreview({
      ownerId,
      media: {
        kind: "raw",
        trackId: context.target.track_id,
        sourceId: context.target.source_id,
        cacheKey: context.media.cache_key,
      },
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
  };
  // Esc during a drag, a lost pointer or a cancelled scrub puts the saved bounds back.
  const cancel = () => {
    const latest = stateRef.current;
    if (latest.kind !== "ready") return;
    const next = {
      ...latest,
      draft: gesture.current?.before ?? {
        start: latest.context.word.start,
        end: latest.context.word.end,
      },
      message: "",
    };
    gesture.current = null;
    stateRef.current = next;
    setState(next);
  };
  // Saves the draft as it stands: on release of a handle, or when a field commits.
  const save = async () => {
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
    ) {
      cancel();
      return;
    }
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
  const commitField = (field: keyof Bounds, value: number) => {
    change(field, value);
    void save();
  };
  const viewport = useMemo(() => ({ scrollLeft: 0, width }), [width]);
  if (state.kind === "loading")
    return <p role="status">Loading source timing…</p>;
  if (state.kind === "error")
    return (
      <>
        <InlineError message={state.message} />
        <Button onClick={() => void reload(word)}>Reload timing</Button>
      </>
    );
  const { context, draft } = state;
  const duration = context.media.duration_sec;
  const disabled = state.kind === "saving" || duration == null;
  const window = context.window;
  const span = window.end - window.start;
  const previous = context.neighbors.find(
    (n) => n.word_index === context.target.word_index - 1,
  );
  const next = context.neighbors.find(
    (n) => n.word_index === context.target.word_index + 1,
  );
  const timeAt = (clientX: number) => {
    const rect = frame.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    const ratio = (clientX - rect.left) / rect.width;
    return window.start + Math.max(0, Math.min(1, ratio)) * span;
  };
  const dragHandle = (field: keyof Bounds) => ({
    onPointerDown: (event: PointerEvent<HTMLSpanElement>) => {
      if (disabled || event.button !== 0 || gesture.current) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      gesture.current = { pointerId: event.pointerId, before: { ...draft } };
    },
    onPointerMove: (event: PointerEvent<HTMLSpanElement>) => {
      if (gesture.current?.pointerId !== event.pointerId) return;
      const at = timeAt(event.clientX);
      if (at != null) change(field, Math.max(0, Math.round(at * 1000) / 1000));
    },
    onPointerUp: (event: PointerEvent<HTMLSpanElement>) => {
      if (gesture.current?.pointerId !== event.pointerId) return;
      void save();
    },
    onPointerCancel: cancel,
  });
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape drops a handle drag in progress; focus stays on whatever opened the editor
    <div
      role="group"
      aria-label="Adjust source timing"
      className="wordbar-editor"
      onKeyDown={(event) => {
        if (event.key === "Escape" && gesture.current) {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
      }}
    >
      <div className="wordbar-waveform" ref={frame}>
        <WaveformLayer
          mediaRef={context.media.ref}
          kind="raw"
          mediaStartSec={window.start}
          clipLeftCss={0}
          clipWidthCss={width}
          zoom={width / span}
          colorVar="var(--color-clip-dialogue-0)"
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
            data-boundary={boundary}
            style={
              {
                "--wordbar-position": `${Math.max(0, Math.min(100, ((draft[boundary] - window.start) / span) * 100))}%`,
              } as CSSProperties
            }
          >
            <span
              className="wordbar-handle"
              aria-hidden="true"
              data-testid={`handle-${boundary}`}
              {...dragHandle(boundary)}
            />
          </span>
        ))}
        <SourceProgress
          ownerId={ownerId}
          start={window.start}
          end={window.end}
        />
      </div>
      <div
        className="wordbar-neighbors"
        role="group"
        aria-label="Neighboring words"
      >
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
                  "--wordbar-position": `${Math.max(0, Math.min(100, ((neighbor.start - window.start) / span) * 100))}%`,
                } as CSSProperties
              }
            >
              {neighbor.text}
            </span>
          ))}
      </div>
      {(["start", "end"] as const).map((field) => (
        <label key={field} className="range-field">
          <span>{field === "start" ? "Start" : "End"}</span>
          <ScrubField
            label={HANDLE_NAMES[field]}
            value={Number.isFinite(draft[field]) ? draft[field] : null}
            unit="s"
            step={0.001}
            decimals={3}
            min={0}
            max={duration ?? undefined}
            readOnly={disabled}
            skipUnchanged
            onPreview={(value) => change(field, value)}
            onCancel={cancel}
            onCommit={(value) => commitField(field, value)}
          />
        </label>
      ))}
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
          Recording duration is unavailable. Wait for its waveform.
        </p>
      ) : null}
      <div className="wordbar-actions">
        <Button
          disabledReason={disabled ? "Saving the timing." : undefined}
          onClick={hearing ? stopPreview : hear}
        >
          {hearing ? "Stop" : "Hear"}
        </Button>
      </div>
      <p role="status">{state.message}</p>
    </div>
  );
}
