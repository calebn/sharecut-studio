import type { ComponentProps, ReactNode, Ref } from "react";
import type { VirtualRowSlotProps } from "../hooks/useVirtualRows";
import type { TranscriptWordView } from "../types/project";
import { HALLUCINATION_WARNING } from "./hallucinationWarning";
import { PROMINENT_NOTE } from "./prominence";

export type TranscriptTurnWord = {
  word: TranscriptWordView;
  trackId: string;
  active?: boolean;
  unmapped?: boolean;
  selected?: boolean;
  lowConfidence?: boolean;
  /** Current stop of the low-confidence walkthrough (#634). */
  reviewCurrent?: boolean;
  suspectHallucination?: boolean;
  /** Prosodically prominent (Prosody layer, #719). */
  prominent?: boolean;
  title?: string;
  ariaLabel?: string;
  anchorProps?: Record<string, string>;
  interactive?: boolean;
  buttonProps?: Pick<
    ComponentProps<"button">,
    "onMouseDown" | "onPointerUp" | "onMouseEnter" | "onClick" | "onDoubleClick"
  >;
  activeRef?: Ref<HTMLElement>;
  boundaryAfter?: ReactNode;
  /** Replaces the word chip while it is edited in place (panel-owned). */
  editor?: ReactNode;
  /** Hover/focus-visible "Restore" control after the last word of an ignored run (#633). */
  restoreControl?: ReactNode;
};

export type TranscriptTurnSegment = {
  key: string;
  active?: boolean;
  unmapped?: boolean;
  activeRef?: Ref<HTMLElement>;
  words: readonly TranscriptTurnWord[];
};

export type TranscriptTurnViewProps = {
  speaker: string;
  labelSec: number;
  seekSec?: number | null;
  onSeek?: () => void;
  active?: boolean;
  unmapped?: boolean;
  turnIndex?: number;
  anchorProps?: Record<string, string>;
  slotProps?: VirtualRowSlotProps;
  boundaryBefore?: ReactNode;
  segments: readonly TranscriptTurnSegment[];
};

/** Production transcript turn paint; interaction and DAW state stay with the panel. */
export function TranscriptTurnView({
  speaker,
  labelSec,
  seekSec,
  onSeek,
  active,
  unmapped,
  turnIndex,
  anchorProps,
  slotProps,
  boundaryBefore,
  segments,
}: TranscriptTurnViewProps) {
  return (
    <div
      className={`utterance-turn${active ? " active" : ""}${unmapped ? " unmapped" : ""}`}
      {...slotProps}
      data-turn-index={turnIndex}
      {...anchorProps}
    >
      {seekSec != null ? (
        <button
          type="button"
          className="utterance-seek"
          title={`Seek turn (${seekSec.toFixed(1)}s)`}
          onClick={onSeek}
        >
          <strong className="utterance-speaker">{speaker}</strong>{" "}
          <span className="utterance-time">[{labelSec.toFixed(1)}s]</span>
        </button>
      ) : (
        <>
          <strong className="utterance-speaker">{speaker}</strong>{" "}
          <span className="utterance-time">[{labelSec.toFixed(1)}s]</span>
        </>
      )}{" "}
      {boundaryBefore}
      {segments.map((segment, segmentIndex) => (
        <span
          key={segment.key}
          ref={segment.activeRef}
          className={`utterance-seg${segment.active ? " active" : ""}${segment.unmapped ? " unmapped" : ""}`}
        >
          {segmentIndex > 0 ? " " : ""}
          {segment.words.map((item, wordIndex) => {
            const chipClass = [
              "utterance-word",
              item.active ? "active" : "",
              item.unmapped ? "unmapped" : "",
              item.word.suppressed ? "suppressed" : "",
              item.word.ignored ? "ignored" : "",
              item.lowConfidence ? "low-confidence" : "",
              item.reviewCurrent ? "review-current" : "",
              item.suspectHallucination ? "suspect-hallucination" : "",
              item.selected ? "selected" : "",
              item.prominent ? "prominent" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <span
                key={`${item.word.start}-${wordIndex}-${item.word.word_index ?? wordIndex}`}
                className={
                  item.restoreControl ? "utterance-restore-anchor" : undefined
                }
              >
                {wordIndex > 0 ? " " : ""}
                {item.editor ??
                  (item.interactive ? (
                    <button
                      type="button"
                      ref={item.activeRef as Ref<HTMLButtonElement>}
                      className={chipClass}
                      data-transcript-word
                      data-track-id={item.trackId}
                      data-word-index={item.word.word_index}
                      {...item.anchorProps}
                      title={item.title}
                      aria-current={item.reviewCurrent ? "true" : undefined}
                      aria-label={
                        item.suspectHallucination
                          ? [
                              item.word.text,
                              item.prominent ? PROMINENT_NOTE : null,
                              item.ariaLabel,
                              HALLUCINATION_WARNING,
                            ]
                              .filter(Boolean)
                              .join(" · ")
                          : item.ariaLabel
                      }
                      {...item.buttonProps}
                    >
                      {item.word.text}
                      {item.prominent && !item.suspectHallucination ? (
                        <span className="sr-only"> {PROMINENT_NOTE}</span>
                      ) : null}
                    </button>
                  ) : (
                    <span
                      ref={item.activeRef as Ref<HTMLSpanElement>}
                      className={chipClass}
                      title={item.title}
                      aria-current={item.reviewCurrent ? "true" : undefined}
                      {...item.anchorProps}
                    >
                      {item.word.text}
                      {item.prominent && (
                        <span className="sr-only"> {PROMINENT_NOTE}</span>
                      )}
                      {item.suspectHallucination && (
                        <span className="sr-only">
                          {" "}
                          {HALLUCINATION_WARNING}
                        </span>
                      )}
                    </span>
                  ))}
                {item.restoreControl}
                {item.boundaryAfter}
              </span>
            );
          })}
        </span>
      ))}
    </div>
  );
}
