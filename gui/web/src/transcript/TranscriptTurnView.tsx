import type { ComponentProps, ReactNode, Ref } from "react";
import type { VirtualRowSlotProps } from "../hooks/useVirtualRows";
import type { TranscriptWordView } from "../types/project";

export type TranscriptTurnWord = {
  word: TranscriptWordView;
  trackId: string;
  active?: boolean;
  unmapped?: boolean;
  selected?: boolean;
  lowConfidence?: boolean;
  suspectHallucination?: boolean;
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
              item.lowConfidence ? "low-confidence" : "",
              item.suspectHallucination ? "suspect-hallucination" : "",
              item.selected ? "selected" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <span
                key={`${item.word.start}-${wordIndex}-${item.word.word_index ?? wordIndex}`}
              >
                {wordIndex > 0 ? " " : ""}
                {item.interactive ? (
                  <button
                    type="button"
                    ref={item.activeRef as Ref<HTMLButtonElement>}
                    className={chipClass}
                    data-transcript-word
                    data-track-id={item.trackId}
                    data-word-index={item.word.word_index}
                    {...item.anchorProps}
                    title={item.title}
                    aria-label={
                      item.suspectHallucination
                        ? [
                            item.word.text,
                            item.ariaLabel,
                            "Possible transcription over silence",
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : item.ariaLabel
                    }
                    {...item.buttonProps}
                  >
                    {item.word.text}
                  </button>
                ) : (
                  <span
                    ref={item.activeRef as Ref<HTMLSpanElement>}
                    className={chipClass}
                    title={item.title}
                    {...item.anchorProps}
                  >
                    {item.word.text}
                    {item.suspectHallucination && (
                      <span className="sr-only">
                        {" "}
                        Possible transcription over silence
                      </span>
                    )}
                  </span>
                )}
                {item.boundaryAfter}
              </span>
            );
          })}
        </span>
      ))}
    </div>
  );
}
