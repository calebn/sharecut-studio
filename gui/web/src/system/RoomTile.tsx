import type { CSSProperties, ReactNode } from "react";
import { presenceColorVar } from "../presence/colors";
import type { SystemIconName } from "./icons";
import { PersonAvatar, type PersonData } from "./Person";
import { ROOM_TILE_TEXT } from "./personStates";
import {
  clipCount,
  effectiveLive,
  type LiveProps,
  type RoomConnection,
  type RoomSaving,
  type RoomTileProps,
  roomTileLabel,
  roomTileStatus,
  savingFraction,
} from "./roomTile";
import { SystemIcon } from "./SystemIcon";

const SIGNAL: Record<RoomConnection, { icon: SystemIconName; title: string }> =
  {
    good: { icon: "signal-high", title: "Good connection" },
    weak: { icon: "signal-low", title: ROOM_TILE_TEXT.weak },
    lost: { icon: "signal-zero", title: "Connection lost" },
  };

function SavingRing({ saving }: { saving: RoomSaving }) {
  const done = saving === "saved";
  const failed = saving === "failed";
  const fraction =
    done || failed ? 1 : savingFraction(saving.done, saving.total);
  const tone = failed ? "warning" : done ? "success" : "progress";
  return (
    <>
      <svg
        className={`sys-room-saving sys-room-saving--${tone}`}
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <circle className="sys-room-saving-track" cx="50" cy="50" r="46" />
        {/* A zero-length arc with round caps would still draw a dot. */}
        {fraction > 0 ? (
          <circle
            className="sys-room-saving-fill"
            cx="50"
            cy="50"
            r="46"
            // pathLength makes the dash a 0..1 share; the turn starts the arc at 12 o'clock.
            pathLength={1}
            strokeDasharray={`${fraction} 1`}
            transform="rotate(-90 50 50)"
          />
        ) : null}
      </svg>
      {done ? (
        <span className="sys-room-saving-mark sys-room-saving-mark--success">
          <SystemIcon name="check" size={14} />
        </span>
      ) : null}
      {failed ? (
        <span className="sys-room-saving-mark sys-room-saving-mark--warning">
          !
        </span>
      ) : null}
    </>
  );
}

type TileBodyProps = {
  props: RoomTileProps & { person: PersonData };
  level?: number;
  speaking?: boolean;
  saving?: RoomSaving | null;
  isMe?: boolean;
  badges?: ReactNode;
  glyphs?: ReactNode;
};

function TileBody({
  props,
  level = 0,
  speaking,
  saving,
  isMe,
  badges,
  glyphs,
}: TileBodyProps) {
  const { person } = props;
  const presence =
    props.presence === "live" && props.connection === "lost"
      ? "lost"
      : props.presence;
  const status = roomTileStatus(props);
  const levelStyle = { "--sys-room-level": level } as CSSProperties;
  return (
    <div
      className="sys-room-tile"
      role="group"
      aria-label={roomTileLabel(props)}
      // A lost connection is a live person, so it shares the dimmed styling of the away states.
      data-presence={presence}
      data-speaking={speaking ? "" : undefined}
      style={
        {
          "--sys-person-color": presenceColorVar(person.colorIndex),
        } as CSSProperties
      }
    >
      {badges}
      <div className="sys-room-main">
        <div className="sys-room-face" style={levelStyle}>
          <PersonAvatar person={person} size={32} />
          {saving ? <SavingRing saving={saving} /> : null}
        </div>
        {status ? <span className="sys-room-status">{status}</span> : null}
      </div>
      <div className="sys-room-foot">
        <div className="sys-room-who">
          <span className="sys-room-name">{person.name}</span>
          {isMe ? (
            <span className="sys-room-meter" aria-hidden="true">
              <span className="sys-room-meter-fill" style={levelStyle} />
            </span>
          ) : null}
        </div>
        {glyphs ? <div className="sys-room-glyphs">{glyphs}</div> : null}
      </div>
    </div>
  );
}

function LiveTile(props: LiveProps) {
  const { connection = "good" } = props;
  const { level, speaking } = effectiveLive(props);
  const clips = clipCount(props.clipped);
  const signal = (
    <SystemIcon
      name={SIGNAL[connection].icon}
      size={16}
      title={SIGNAL[connection].title}
      className={`sys-room-signal sys-room-signal--${connection}`}
    />
  );
  return (
    <TileBody
      props={props}
      level={level}
      speaking={speaking}
      saving={props.saving}
      isMe={props.isMe}
      badges={
        props.alert || clips ? (
          <div className="sys-room-badges">
            {props.alert ? (
              <span className="sys-room-alert">
                <SystemIcon name="triangle-alert" size={16} />
              </span>
            ) : null}
            {clips ? (
              <span className="sys-room-clip" aria-hidden="true">
                {clips}
              </span>
            ) : null}
          </div>
        ) : null
      }
      glyphs={
        <>
          {props.muted ? (
            <SystemIcon name="mic-off" size={16} title="Muted" />
          ) : null}
          {props.listener ? (
            <>
              {/* Quiet when fine: a listener's good signal is not worth a glyph. */}
              {connection === "good" ? null : signal}
              <SystemIcon name="ear" size={16} title="Listening" />
            </>
          ) : (
            signal
          )}
        </>
      }
    />
  );
}

/**
 * The live-room form of the shared person tile: 4:3, avatar whose ring is the
 * level, name, glyph cluster and badges. Presentational; the level arrives as
 * a prop and nothing animates yet.
 */
export function RoomTile(props: RoomTileProps) {
  if (props.presence === "placeholder") {
    return (
      <button
        type="button"
        className="sys-room-tile sys-room-tile--placeholder"
        onClick={props.onInvite}
      >
        <SystemIcon name="user-plus" size={20} />
        <span>{ROOM_TILE_TEXT.invite}</span>
      </button>
    );
  }
  if (props.presence === "live") return <LiveTile {...props} />;
  return (
    <TileBody
      props={props}
      glyphs={
        props.presence === "declined" ? (
          <SystemIcon name="mic-off" size={16} />
        ) : null
      }
    />
  );
}

/** Avatar-only form for the listener row: 28 px and an ear glyph. */
export function ListenerAvatar({
  person,
  label,
}: {
  person: PersonData;
  /** Printed name when it differs from the person's, such as "You". */
  label?: string;
}) {
  const name = label ?? person.name;
  return (
    <li className="sys-room-listener">
      <PersonAvatar person={person} size={28} />
      <span className="sys-room-listener-glyph">
        <SystemIcon name="ear" size={12} />
      </span>
      <span className="sr-only">{`${name}, listening`}</span>
    </li>
  );
}

export function ListenerRow({ children }: { children: ReactNode }) {
  return (
    <ul className="sys-room-listeners" aria-label="Listening">
      {children}
    </ul>
  );
}
