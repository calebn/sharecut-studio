import {
  type CSSProperties,
  type FocusEvent,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useState,
} from "react";
import { presenceColorVar } from "../presence/colors";
import { Cover } from "./Cover";
import { PersonAvatar } from "./Person";
import { percentOf } from "./progress";
import { Seam } from "./Seam";
import { Skeleton } from "./Skeleton";
import { StatusRow } from "./StatusRow";
import { Suggestion } from "./Suggestion";
import { SystemIcon } from "./SystemIcon";
import {
  continuesSpeaker,
  pieceEnd,
  pieceStart,
  piecesOf,
  type ScriptCaret,
  type ScriptPiece,
  type ScriptSpan,
  type ScriptStatus,
  type ScriptTurn,
  type ScriptWord,
} from "./scriptPieces";

export type ScriptPaneProps = {
  turns: readonly ScriptTurn[];
  status?: ScriptStatus;
  /** `phone` reads at 17/28 instead of 16/26. */
  layout?: "desktop" | "phone";
  /** The word under the playhead. */
  playing?: number;
  selection?: ScriptSpan | null;
  /** The first word of the cut whose pill is selected. */
  selectedCut?: number;
  carets?: readonly ScriptCaret[];
  /** Cut words show struck instead of collapsing into a pill. */
  showCutText?: boolean;
  /** The pane scrolls with the playhead. Off, "Back to playhead" shows. */
  following?: boolean;
  /** A guest reads, selects and comments. Fixing and cutting are not offered. */
  guest?: "viewer" | "commenter";
  /** A word was pressed. `extend` is true for Shift, which grows the selection. */
  onWord: (index: number, extend: boolean) => void;
  onSeamSelect: (span: ScriptSpan) => void;
  onSuggestionSelect: (span: ScriptSpan) => void;
  onFind: () => void;
  /** Jump to the next word the transcript is unsure of. */
  onNextUnsure: () => void;
  onShowCutTextChange: (show: boolean) => void;
  onFollowChange: (follow: boolean) => void;
  onBackToPlayhead: () => void;
};

const NO_CARETS: readonly ScriptCaret[] = [];

const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

const within = (span: ScriptSpan | null | undefined, index: number) =>
  span !== null &&
  span !== undefined &&
  index >= span.start &&
  index <= span.end;

const overlaps = (
  span: ScriptSpan | null | undefined,
  from: number,
  to: number,
) =>
  span !== null && span !== undefined && span.start <= to && span.end >= from;

function stopFor(key: string, at: number, count: number): number | null {
  switch (key) {
    case "ArrowRight":
      return Math.min(count - 1, at + 1);
    case "ArrowLeft":
      return Math.max(0, at - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

function stopsOf(piece: ScriptPiece): number[] {
  return piece.kind === "muted"
    ? piece.words.map((word) => word.index)
    : [pieceStart(piece)];
}

export function ScriptPane({
  turns,
  status = { kind: "ready" },
  layout = "desktop",
  playing,
  selection = null,
  selectedCut,
  carets = NO_CARETS,
  showCutText = false,
  following = true,
  guest,
  onWord,
  onSeamSelect,
  onSuggestionSelect,
  onFind,
  onNextUnsure,
  onShowCutTextChange,
  onFollowChange,
  onBackToPlayhead,
}: ScriptPaneProps) {
  const [focused, setFocused] = useState<number | null>(null);
  const piecesByTurn = turns.map((turn) => piecesOf(turn.words, showCutText));
  const stops = piecesByTurn.flatMap((pieces) => pieces.flatMap(stopsOf));
  const unsure = turns.reduce(
    (sum, turn) => sum + turn.words.filter((w) => w.lowConfidence).length,
    0,
  );

  const ownCaret = carets.find((caret) => caret.person === undefined)?.before;
  const anchor = ownCaret ?? playing;
  const holder = piecesByTurn
    .flat()
    .find(
      (piece) =>
        anchor !== undefined &&
        pieceStart(piece) <= anchor &&
        anchor <= pieceEnd(piece),
    );
  const holderStops = holder === undefined ? [] : stopsOf(holder);
  const tabStop =
    focused !== null && stops.includes(focused)
      ? focused
      : (holderStops.find((stop) => stop === anchor) ??
        holderStops[0] ??
        stops[0]);

  const showHeader =
    status.kind === "ready" ||
    status.kind === "transcribing" ||
    status.kind === "outOfDate";

  if (status.kind === "empty") {
    return (
      <section className="sys-script" aria-label="Script" data-layout={layout}>
        <Cover
          size="region"
          glyph="file-plus"
          title="No transcript yet"
          primary={{
            label: "Transcribe this episode",
            onClick: status.onTranscribe,
          }}
        >
          Transcribe this episode to edit it by reading.
        </Cover>
      </section>
    );
  }

  function onFocus(event: FocusEvent<HTMLElement>) {
    const stop = event.currentTarget.closest<HTMLElement>("[data-stop]");
    if (stop) setFocused(Number(stop.dataset.stop));
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const current = event.currentTarget.closest<HTMLElement>("[data-stop]");
    const body = event.currentTarget.closest(".sys-script-body");
    if (!current || !body || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const all = [...body.querySelectorAll<HTMLElement>("[data-stop]")];
    const target = stopFor(event.key, all.indexOf(current), all.length);
    if (target === null) return;
    event.preventDefault();
    const next = all[target];
    const control = next.matches("button")
      ? next
      : next.querySelector<HTMLElement>("button");
    control?.focus();
    if (event.shiftKey && event.key.startsWith("Arrow")) {
      onWord(Number(next.dataset.stop), true);
    }
  }

  return (
    <section className="sys-script" aria-label="Script" data-layout={layout}>
      {showHeader ? (
        <div className="sys-script-header">
          <div className="sys-script-tools">
            <button
              type="button"
              className="sys-script-tool"
              aria-label="Find in transcript"
              onClick={onFind}
            >
              <SystemIcon name="text-search" size={16} />
            </button>
            {unsure > 0 ? (
              <button
                type="button"
                className="sys-script-tool sys-script-unsure"
                aria-label={`? ${unsure} unsure ${unsure === 1 ? "word" : "words"}, go to the next`}
                onClick={onNextUnsure}
              >
                <span aria-hidden="true">? {unsure}</span>
              </button>
            ) : null}
            <button
              type="button"
              className="sys-script-tool"
              aria-label="Show cut text"
              aria-pressed={showCutText}
              onClick={() => onShowCutTextChange(!showCutText)}
            >
              <SystemIcon name={showCutText ? "eye" : "eye-off"} size={16} />
            </button>
            <button
              type="button"
              className="sys-script-tool"
              aria-label="Follow the playhead"
              aria-pressed={following}
              onClick={() => onFollowChange(!following)}
            >
              <SystemIcon name="pin" size={16} />
            </button>
          </div>
          {guest ? (
            <span className="sys-script-guest">
              {guest === "commenter"
                ? "Read only · you can comment"
                : "Read only"}
            </span>
          ) : null}
          <div className="sys-script-notice">
            {status.kind === "transcribing" ? (
              <StatusRow
                density="inline"
                state="running"
                title="Transcribing"
                detail={`${percentOf(status.progress)}%`}
                valueText={`${percentOf(status.progress)} percent`}
                progress={status.progress}
              />
            ) : null}
            {status.kind === "outOfDate" ? (
              <StatusRow
                density="inline"
                state="needs-you"
                title="Transcript out of date"
                action={{ label: "Update", onAction: status.onUpdate }}
              />
            ) : null}
          </div>
        </div>
      ) : null}
      {status.kind === "loading" ? (
        <Skeleton
          rows={6}
          elapsedMs={status.elapsedMs}
          onRetry={status.onRetry}
        />
      ) : (
        <div className="sys-script-body">
          {turns.map((turn, turnIndex) => {
            const continued = continuesSpeaker(turn, turns[turnIndex - 1]);
            const pieces = piecesByTurn[turnIndex];
            return (
              <div
                key={turn.id}
                role="group"
                className="sys-script-turn"
                aria-label={`${firstName(turn.speaker.name)}, ${turn.time}`}
              >
                <div
                  className="sys-script-margin"
                  style={
                    {
                      "--sys-person-color": presenceColorVar(
                        turn.speaker.colorIndex,
                      ),
                    } as CSSProperties
                  }
                >
                  {continued ? null : (
                    <>
                      <span className="sys-script-speaker">
                        <PersonAvatar person={turn.speaker} size={20} />
                        <span className="sys-script-name">
                          {firstName(turn.speaker.name)}
                        </span>
                      </span>
                      <span className="sys-script-time">{turn.time}</span>
                    </>
                  )}
                </div>
                <p className="sys-script-text">
                  {pieces.map((piece, pieceIndex) => {
                    const start = pieceStart(piece);
                    const previous = pieces[pieceIndex - 1];
                    return (
                      <Fragment key={start}>
                        {previous ? (
                          <Gap
                            selected={
                              selection !== null &&
                              pieceEnd(previous) >= selection.start &&
                              start <= selection.end
                            }
                          />
                        ) : null}
                        <Carets
                          carets={carets}
                          from={start}
                          to={pieceEnd(piece)}
                        />
                        {renderPiece(piece)}
                      </Fragment>
                    );
                  })}
                </p>
              </div>
            );
          })}
          {status.kind === "transcribing" && status.notYet ? (
            <p className="sys-script-notyet">
              Not transcribed yet · {status.notYet}
            </p>
          ) : null}
        </div>
      )}
      {!following && playing !== undefined ? (
        <button
          type="button"
          className="sys-script-back"
          onClick={onBackToPlayhead}
        >
          <SystemIcon name="locate-fixed" size={14} />
          Back to playhead
        </button>
      ) : null}
    </section>
  );

  function renderWord(word: ScriptWord): ReactNode {
    const selected = within(selection, word.index);
    return (
      <button
        type="button"
        className="sys-script-word"
        data-stop={word.index}
        data-state={word.state}
        data-playing={word.index === playing ? "" : undefined}
        data-selected={selected ? "" : undefined}
        data-unsure={word.lowConfidence ? "" : undefined}
        data-restored={word.restored ? "" : undefined}
        tabIndex={word.index === tabStop ? 0 : -1}
        aria-label={nameOf(word)}
        aria-pressed={selected}
        aria-current={word.index === playing ? "true" : undefined}
        onClick={(event) => onWord(word.index, event.shiftKey)}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
      >
        {word.text}
      </button>
    );
  }

  function renderPiece(piece: ScriptPiece): ReactNode {
    switch (piece.kind) {
      case "word":
        return renderWord(piece.word);
      case "cut":
        return (
          <span className="sys-script-pill" data-stop={piece.start}>
            <Seam
              form="pill"
              removed={piece.removed}
              words={piece.words}
              selected={selectedCut === piece.start}
              onKeyDown={onKeyDown}
              onSelect={() =>
                onSeamSelect({ start: piece.start, end: piece.end })
              }
            />
          </span>
        );
      case "suggestion": {
        const selected = overlaps(selection, piece.start, piece.end);
        return (
          <button
            type="button"
            className="sys-script-run"
            data-stop={piece.start}
            data-selected={selected ? "" : undefined}
            tabIndex={piece.start === tabStop ? 0 : -1}
            aria-label={`Suggested cut: ${piece.text}`}
            onFocus={onFocus}
            onKeyDown={onKeyDown}
            onClick={() =>
              onSuggestionSelect({ start: piece.start, end: piece.end })
            }
          >
            <Suggestion segments={[{ text: piece.text, struck: true }]} />
          </button>
        );
      }
      case "muted":
        return (
          <span className="sys-script-muted">
            <span className="sr-only">Muted: </span>
            <SystemIcon name="volume-x" size={14} />
            {piece.words.map((word, wordIndex) => (
              <Fragment key={word.index}>
                {wordIndex > 0 ? (
                  <Gap
                    selected={
                      selection !== null &&
                      piece.words[wordIndex - 1].index >= selection.start &&
                      word.index <= selection.end
                    }
                  />
                ) : null}
                <Carets carets={carets} from={word.index} to={word.index} />
                {renderWord(word)}
              </Fragment>
            ))}
          </span>
        );
    }
  }
}

function nameOf(word: ScriptWord): string | undefined {
  const notes = [
    word.lowConfidence ? "unsure" : null,
    word.restored ? "restored" : null,
  ].filter((note) => note !== null);
  return notes.length > 0 ? `${word.text} (${notes.join(", ")})` : undefined;
}

function Gap({ selected }: { selected: boolean }) {
  return (
    <span className="sys-script-gap" data-selected={selected ? "" : undefined}>
      {" "}
    </span>
  );
}

function Carets({
  carets,
  from,
  to,
}: {
  carets: readonly ScriptCaret[];
  from: number;
  to: number;
}) {
  return carets
    .filter((caret) => caret.before >= from && caret.before <= to)
    .map((caret) => (
      <span
        key={caret.person?.name ?? "own"}
        className="sys-script-caret"
        data-own={caret.person ? undefined : ""}
        style={
          caret.person
            ? ({
                "--sys-person-color": presenceColorVar(caret.person.colorIndex),
              } as CSSProperties)
            : undefined
        }
        aria-hidden={caret.person ? undefined : "true"}
      >
        {caret.person ? (
          <span className="sr-only">{caret.person.name}'s cursor</span>
        ) : null}
      </span>
    ));
}
