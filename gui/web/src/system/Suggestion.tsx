import { useId } from "react";
import { SystemIcon } from "./SystemIcon";

export type SuggestionSegment = {
  text: string;
  /** Words the suggestion removes. */
  struck?: boolean;
  /** A word the transcript is unsure of. */
  unsure?: boolean;
};

export type SuggestionProps =
  | {
      kind?: "words";
      segments: readonly SuggestionSegment[];
    }
  | {
      kind: "pause";
      /** "2.9 s" */
      length: string;
      /** Where the pause ends up: "0.6 s". Omit for a pause that goes away. */
      to?: string;
    };

/** A hatched gap: the pause glyph. Hatch means proposed. */
export function PauseGlyph({ size = 16 }: { size?: number }) {
  const id = useId();
  return (
    <svg
      className="sys-sugg-pause-glyph"
      width={size * 2}
      height={size}
      viewBox="0 0 32 16"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <pattern
          id={id}
          width="4"
          height="4"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="4" />
        </pattern>
      </defs>
      <rect x="1" y="1" width="30" height="14" rx="3" fill={`url(#${id})`} />
    </svg>
  );
}

/**
 * One drawing for a proposed change. Words the change removes are struck in
 * the cut colour on a hatch; a pause is a hatched gap. A solid strike belongs
 * to a change already applied, so none is drawn here.
 */
export function Suggestion(props: SuggestionProps) {
  if (props.kind === "pause") {
    return (
      <span className="sys-sugg sys-sugg--pause">
        <PauseGlyph />
        <span className="sys-mono">{props.length}</span>
        {props.to ? (
          <>
            <SystemIcon name="arrow-right" size={12} />
            <span className="sys-mono">{props.to}</span>
          </>
        ) : null}
      </span>
    );
  }
  return (
    <span className="sys-sugg">
      {props.segments.map((segment, index) => {
        const inner = segment.unsure ? (
          <span className="sys-sugg-unsure">{segment.text}</span>
        ) : (
          segment.text
        );
        return segment.struck ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
          <del key={index} className="sys-sugg-struck">
            <span className="sr-only">Removed: </span>
            {inner}
          </del>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
          <span key={index}>{inner}</span>
        );
      })}
    </span>
  );
}
