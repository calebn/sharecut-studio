import { HoverTip } from "./HoverTip";
import { SystemIcon } from "./SystemIcon";
import { useHoverTip } from "./useHoverTip";

export type SeamKind = "cut" | "split";

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
    };

export type SeamProps = SeamFormProps & {
  selected?: boolean;
  onSelect: () => void;
};

export function Seam(props: SeamProps) {
  const { selected = false, onSelect } = props;
  const { open, id, anchor, setAnchor, handlers } =
    useHoverTip<HTMLButtonElement>();
  const diamond = props.form === "diamond";
  const name = diamond ? props.label : `Cut, ${props.removed} removed`;
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
        aria-describedby={hasTip && open ? id : undefined}
        onClick={onSelect}
      >
        {diamond ? (
          <span className="sys-seam-diamond" aria-hidden="true" />
        ) : (
          <>
            <SystemIcon name="scissors" size={12} />
            <span aria-hidden="true">{props.removed}</span>
          </>
        )}
      </button>
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
              <span className="sys-tip-title">Cut {props.removed}</span>
              <span className="sys-tip-detail">{props.words}</span>
            </>
          )}
        </HoverTip>
      ) : null}
    </span>
  );
}
