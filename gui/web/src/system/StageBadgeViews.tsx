import { useElapsedSince } from "../hooks/useElapsedSince";
import { RoomStatusPill } from "./RoomStatusPill";
import { StatusGlyph } from "./StatusGlyph";
import { STATUS_TEXT, type StatusState } from "./statusText";

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
      phase={{ kind: "live", clockSec: (clockMs + elapsedMs) / 1000 }}
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
