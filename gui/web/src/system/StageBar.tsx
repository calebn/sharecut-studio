import { useElapsedSince } from "../hooks/useElapsedSince";
import type { StageId } from "../types/stage";
import { TabList } from "../ui/Tabs";
import { RoomStatusPill } from "./RoomStatusPill";
import { StatusGlyph } from "./StatusGlyph";
import { SystemIcon } from "./SystemIcon";
import { stageBadge } from "./stageBadge";
import { STATUS_TEXT, type StatusState } from "./statusText";
import { STAGES } from "./verbs";

export type StageBadge = { kind: StatusState; count?: number };

/** `alert`: something in the room needs the host; on the others it adds a dot. */
export type RecordBadge =
  | { kind: "idle" }
  | { kind: "waiting"; count: number }
  | {
      kind: "live";
      /** The take clock when the snapshot arrived. */
      clockMs: number;
      /** `performance.now()` at that moment, so the clock survives a reconnect. */
      receivedAtMs: number | null;
      alert?: boolean;
    }
  | { kind: "paused"; alert?: boolean }
  | { kind: "reconnecting"; alert?: boolean }
  | { kind: "saving"; progress?: number; alert?: boolean }
  | { kind: "alert" };

export type StageBarProps = {
  active: StageId;
  onSelect: (stage: StageId) => void;
  /** Stages shown, in order. A guest Editor sees two. */
  stages?: readonly StageId[];
  badges?: Partial<Record<StageId, StageBadge>>;
  /** `bar`: header segments. `tabs`: the phone tab bar, an icon over a label. */
  form?: "bar" | "tabs";
  /** What the Record item says about the room; a `failed` badge for Record outranks it. */
  record?: RecordBadge;
  label?: string;
  /** Id of the stage content, for `aria-controls`. */
  panelId?: string;
};

export function Badge({ badge }: { badge: StageBadge }) {
  const text = STATUS_TEXT[badge.kind];
  return (
    <span className="sys-stage-badge">
      <StatusGlyph state={badge.kind} dot size={12} text={false} />
      {badge.count ? (
        <span aria-hidden="true" className="sys-stage-count">
          {badge.count}
        </span>
      ) : null}
      <span className="sr-only">
        {badge.count ? `${badge.count}, ${text}` : text}
      </span>
    </span>
  );
}

/** The only part of the Record badge that changes each second; the tabs around it stay put. */
function LiveClock({
  clockMs,
  receivedAtMs,
}: {
  clockMs: number;
  receivedAtMs: number | null;
}) {
  const elapsedMs = useElapsedSince(receivedAtMs, true);
  return (
    <RoomStatusPill
      compact
      phase={{ kind: "live", take: 0, clockSec: (clockMs + elapsedMs) / 1000 }}
    />
  );
}

/**
 * The name carries the state, never the clock: a tab whose name changed every
 * second would be read out every second.
 */
function recordName(badge: RecordBadge): string {
  const alert = "alert" in badge && badge.alert ? ", needs attention" : "";
  switch (badge.kind) {
    case "idle":
      return "";
    case "waiting":
      return `${badge.count} waiting`;
    case "live":
      return `Live${alert}`;
    case "paused":
      return `Paused${alert}`;
    case "reconnecting":
      return `Reconnecting${alert}`;
    case "saving":
      return `Saving${alert}`;
    case "alert":
      return "Needs attention";
  }
}

export function RecordBadgeView({ badge }: { badge: RecordBadge }) {
  if (badge.kind === "idle") return null;
  const pill = badge.kind === "live" || badge.kind === "paused";
  return (
    <span className={`sys-stage-badge${pill ? " sys-stage-badge--pill" : ""}`}>
      {badge.kind === "live" ? (
        <span aria-hidden="true">
          <LiveClock
            clockMs={badge.clockMs}
            receivedAtMs={badge.receivedAtMs}
          />
        </span>
      ) : null}
      {badge.kind === "paused" ? (
        <span aria-hidden="true">
          <RoomStatusPill compact phase={{ kind: "paused", clockSec: 0 }} />
        </span>
      ) : null}
      {badge.kind === "reconnecting" ? (
        <StatusGlyph state="offline" dot text={false} />
      ) : null}
      {badge.kind === "saving" ? (
        <StatusGlyph
          state="running"
          progress={badge.progress}
          size={12}
          text={false}
        />
      ) : null}
      {badge.kind === "waiting" ? (
        <span aria-hidden="true" className="sys-stage-count">
          {badge.count}
        </span>
      ) : null}
      {badge.kind === "alert" || ("alert" in badge && badge.alert) ? (
        <StatusGlyph state="needs-you" dot text={false} />
      ) : null}
      <span className="sr-only">{recordName(badge)}</span>
    </span>
  );
}

/**
 * The five stages as one tab list; `ui/Tabs` owns the roving keys. Under 1100 px
 * (68.75rem) the inactive segments show the icon only and keep the label in the
 * accessible name. The width is the nearest container's: the App header, or
 * the bar itself when it stands alone.
 */
export function StageBar({
  active,
  onSelect,
  stages,
  badges,
  form = "bar",
  record,
  label = "Stages",
  panelId,
}: StageBarProps) {
  const shown = STAGES.filter((stage) =>
    stages ? stages.includes(stage.id) : true,
  );
  const tabs = shown.map((stage) => {
    const selected = stage.id === active;
    const badge = stageBadge(stage.id, badges, record);
    return (
      <button
        key={stage.id}
        type="button"
        role="tab"
        aria-selected={selected}
        aria-controls={panelId}
        tabIndex={selected ? 0 : -1}
        className="sys-stage-tab"
        title={stage.label}
        onClick={() => onSelect(stage.id)}
      >
        <SystemIcon name={stage.icon} size={form === "tabs" ? 24 : 16} />
        <span className="sys-stage-label">{stage.label}</span>
        {/* A text node between the label and the badge keeps the words apart in the accessible name. */}
        {badge ? " " : null}
        {badge}
      </button>
    );
  });
  return (
    <div className={`sys-stage-bar sys-stage-bar--${form}`}>
      <TabList label={label} className="sys-stage-list">
        {tabs}
      </TabList>
    </div>
  );
}
