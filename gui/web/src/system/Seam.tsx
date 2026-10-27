import { type KeyboardEvent, useId } from "react";
import { HoverTip } from "./HoverTip";
import { SystemIcon } from "./SystemIcon";
import { useHoverTip } from "./useHoverTip";

type SeamKind = "cut" | "split";

type SeamFormProps =
  | {
      form: "diamond";
      kind: SeamKind;
      /** What the seam is, with its time: "Cut at 12:04.3". It names the button and heads the tip. */
      label: string;
      /** A second tip line: "2.4 s removed". */
      detail?: string;
    }
  | {
      form: "pill";
      /** The removed length, already formatted: "2.4 s". */
      removed: string;
      /** The words the cut took out, shown in the tip. */
      words?: string;
      /** The cut began in an earlier turn. The pill says so instead of repeating the length. */
      continued?: boolean;
      /** The cut runs on into the next turn. */
      continues?: boolean;
    };

export type SeamProps = SeamFormProps & {
  selected?: boolean;
  onSelect: () => void;
  /** For a host that moves focus among its marks, as the Script pane does among its words. */
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /** With `onKeyDown`, the roving tab stop: 0 for the one stop, -1 for the rest. Left out, the button is a tab stop of its own. */
  tabIndex?: number;
};

function pillName(props: Extract<SeamProps, { form: "pill" }>): string {
  if (props.continued) {
    return props.continues
      ? "Cut, continued from the previous turn and on into the next"
      : "Cut, continued from the previous turn";
  }
  return props.continues
    ? `Cut, ${props.removed} removed, continues in the next turn`
    : `Cut, ${props.removed} removed`;
}

export function Seam(props: SeamProps) {
  const { selected = false, onSelect, onKeyDown, tabIndex } = props;
  const { open, id, anchor, setAnchor, handlers } =
    useHoverTip<HTMLButtonElement>();
  const wordsId = useId();
  const diamond = props.form === "diamond";
  const words = props.form === "pill" ? props.words : undefined;
  const name = diamond
    ? props.detail
      ? `${props.label}, ${props.detail}`
      : props.label
    : pillName(props);
  const hasTip = diamond || Boolean(props.words);
  return (
    <span
      className="sys-seam"
      data-form={props.form}
      data-kind={diamond ? props.kind : "cut"}
      {...handlers}
    >
      <button
        ref={setAnchor}
        type="button"
        className="sys-seam-hit"
        aria-label={name}
        aria-pressed={selected}
        aria-describedby={words ? wordsId : undefined}
        tabIndex={tabIndex}
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        {diamond ? (
          <span className="sys-seam-diamond" aria-hidden="true" />
        ) : (
          <>
            <SystemIcon name="scissors" size={12} />
            <span aria-hidden="true">
              {props.continued ? "continued" : props.removed}
            </span>
          </>
        )}
      </button>
      {words ? (
        <span id={wordsId} className="sr-only">
          {words}
        </span>
      ) : null}
      {hasTip && open && anchor ? (
        <HoverTip id={id} anchor={anchor}>
          {diamond ? (
            <>
              <span className="sys-tip-title">{props.label}</span>
              {props.detail ? (
                <span className="sys-tip-detail">{props.detail}</span>
              ) : null}
            </>
          ) : (
            <>
              <span className="sys-tip-title">
                {props.continued ? "Cut continued" : `Cut ${props.removed}`}
              </span>
              <span className="sys-tip-detail">{props.words}</span>
            </>
          )}
        </HoverTip>
      ) : null}
    </span>
  );
}
