import { useId } from "react";
import { SystemIcon } from "./SystemIcon";
import { formatSeconds } from "./seconds";

export type SuggestionSegment = {
  text: string;
  struck?: boolean;
  /** A word the transcript is unsure of. */
  unsure?: boolean;
};

export type SuggestionProps =
  | {
      kind?: "words";
      segments: readonly SuggestionSegment[];
      /** One line: the change always shows, and the text around it gives way first. */
      focus?: boolean;
    }
  | {
      kind: "pause";
      /** Seconds. */
      length: number;
      /** Seconds the pause is shortened to. Omit for a pause that goes away. */
      to?: number;
    };

/** Hatch means proposed. */
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
 * Hatch means proposed: a solid strike belongs to a change already applied,
 * so none is drawn here.
 */
export function Suggestion(props: SuggestionProps) {
  if (props.kind === "pause") {
    return (
      <span className="sys-sugg sys-sugg--pause">
        <PauseGlyph />
        <span className="sys-mono">{formatSeconds(props.length)}</span>
        {props.to === undefined ? null : (
          <>
            <SystemIcon name="arrow-right" size={12} />
            <span className="sys-mono">{formatSeconds(props.to)}</span>
          </>
        )}
      </span>
    );
  }
  const { segments, focus } = props;
  const first = segments.findIndex((segment) => segment.struck);
  const last = segments.findLastIndex((segment) => segment.struck);
  if (!focus || first === -1) {
    return <span className="sys-sugg">{words(segments, 0)}</span>;
  }
  const offsetOf = (index: number) =>
    segments.slice(0, index).reduce((sum, s) => sum + s.text.length, 0);
  return (
    <span className="sys-sugg sys-sugg--focus">
      <span className="sys-sugg-lead">
        <span className="sys-sugg-lead-text">
          {words(segments.slice(0, first), 0)}
        </span>
      </span>
      <span className="sys-sugg-change">
        {words(segments.slice(first, last + 1), offsetOf(first))}
      </span>
      <span className="sys-sugg-trail">
        {words(segments.slice(last + 1), offsetOf(last + 1))}
      </span>
    </span>
  );
}

function words(segments: readonly SuggestionSegment[], start: number) {
  let offset = start;
  return segments.map((segment) => {
    const key = offset;
    offset += segment.text.length;
    const inner = segment.unsure ? (
      <span className="sys-sugg-unsure">{segment.text}</span>
    ) : (
      segment.text
    );
    return segment.struck ? (
      <del key={key} className="sys-sugg-struck">
        <span className="sr-only">Removed: </span>
        {inner}
      </del>
    ) : (
      <span key={key}>{inner}</span>
    );
  });
}
