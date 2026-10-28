import type {
  ButtonHTMLAttributes,
  CSSProperties,
  MouseEvent,
  ReactNode,
} from "react";
import { HoverTip } from "./HoverTip";
import { SystemIcon } from "./SystemIcon";
import { useHoverTip } from "./useHoverTip";

type MarkerKindProps =
  | {
      kind: "chapter";
      title: string;
      time: string;
      /** Where the next marker starts, as a fraction of the lane; the title is cut off there. */
      to?: number;
    }
  | {
      kind: "comment";
      author: string;
      time: string;
      /** The end of a range comment, as a fraction of the lane. It draws the span bar. */
      to?: number;
    }
  | {
      kind: "clip";
      title: string;
      time: string;
      to: number;
      /** Hatched while proposed, solid once approved. */
      proposed: boolean;
    }
  | {
      /** Markers that overlap at this zoom; selecting it opens the list. */
      kind: "stack";
      count: number;
    };

/** `data-*` attributes the host wants on the marker's elements, such as a hit target. */
export type MarkerAttrs = Readonly<Record<string, string>>;

export type MarkerProps = MarkerKindProps & {
  /** Start, as a fraction of the lane from its inline start. The lane is the positioned parent. */
  at: number;
  selected?: boolean;
  dragging?: boolean;
  /** A "+N" chip sits just after this marker's start, so its start edge hit area gives way. */
  stacked?: boolean;
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Custom properties for the root, such as the reach of a touch hit area. */
  rootStyle?: CSSProperties;
  /** Pointer, key and `data-*` props for the hit button; the lane that moves markers owns the gesture. */
  buttonProps?: Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    | "aria-label"
    | "aria-pressed"
    | "aria-describedby"
    | "className"
    | "type"
    | "onClick"
  > &
    MarkerAttrs;
  /** Siblings of the button inside the marker, such as the edge handles of a bracket. */
  children?: ReactNode;
};

function initialOf(name: string): string {
  return (Array.from(name.trim())[0] ?? "").toUpperCase();
}

function nameOf(props: MarkerProps): string {
  switch (props.kind) {
    case "chapter":
      return `Chapter ${props.title}, ${props.time}`;
    case "comment":
      return `Comment by ${props.author}, ${props.time}`;
    case "clip":
      return `Clip idea ${props.title}, ${props.proposed ? "proposed" : "approved"}, ${props.time}`;
    case "stack":
      return `${props.count} more markers`;
  }
}

function tipLines(props: MarkerProps): { title: string; time: string } | null {
  switch (props.kind) {
    case "chapter":
    case "clip":
      return { title: props.title, time: props.time };
    case "comment":
      return { title: props.author, time: props.time };
    case "stack":
      return null;
  }
}

function Glyph(props: MarkerProps) {
  switch (props.kind) {
    case "chapter":
      return (
        <>
          <SystemIcon name="flag" size={12} />
          <span className="sys-marker-title">{props.title}</span>
        </>
      );
    case "comment":
      return (
        <>
          {props.to !== undefined ? (
            <span className="sys-marker-bar" aria-hidden="true" />
          ) : null}
          <span className="sys-marker-bubble" aria-hidden="true">
            {initialOf(props.author)}
          </span>
        </>
      );
    case "clip":
      return (
        <>
          <span className="sys-marker-bracket" aria-hidden="true" />
          <span className="sys-marker-line" aria-hidden="true" />
          <span
            className="sys-marker-bracket sys-marker-bracket--end"
            aria-hidden="true"
          />
        </>
      );
    case "stack":
      return <span aria-hidden="true">+{props.count}</span>;
  }
}

export function Marker(props: MarkerProps) {
  const {
    at,
    selected = false,
    dragging = false,
    stacked = false,
    onSelect,
    rootStyle,
    buttonProps,
    children,
  } = props;
  const to = props.kind === "stack" ? undefined : props.to;
  const { open, id, anchor, setAnchor, handlers } =
    useHoverTip<HTMLButtonElement>();
  const lines = tipLines(props);
  const style = {
    "--sys-marker-at": at,
    ...(to === undefined ? {} : { "--sys-marker-to": to }),
    ...rootStyle,
  } as CSSProperties;
  return (
    <span
      className="sys-marker"
      data-kind={props.kind}
      data-span={to === undefined ? undefined : "true"}
      data-selected={selected || undefined}
      data-dragging={dragging || undefined}
      data-stacked={stacked || undefined}
      data-proposed={
        props.kind === "clip" && props.proposed ? "true" : undefined
      }
      style={style}
      {...handlers}
    >
      <button
        ref={setAnchor}
        type="button"
        className="sys-marker-hit"
        aria-label={nameOf(props)}
        aria-pressed={props.kind === "stack" ? undefined : selected}
        aria-haspopup={props.kind === "stack" ? "true" : undefined}
        aria-describedby={lines && open ? id : undefined}
        {...buttonProps}
        onClick={onSelect}
      >
        <Glyph {...props} />
      </button>
      {children}
      {lines && open && anchor ? (
        <HoverTip id={id} anchor={anchor}>
          <span className="sys-tip-title">{lines.title}</span>
          <span className="sys-tip-detail">{lines.time}</span>
        </HoverTip>
      ) : null}
    </span>
  );
}
