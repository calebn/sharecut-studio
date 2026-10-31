import {
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  memo,
  useId,
  useRef,
} from "react";
import { presenceColorVar } from "../presence/colors";
import type { MuteState } from "../utils/audio";
import { clamp } from "../utils/math";
import { useStableCallback } from "../utils/useStableCallback";
import { PersonAvatar } from "./Person";
import { ScrubField } from "./ScrubField";
import { SystemIcon } from "./SystemIcon";

export type TrackHeaderForm = "default" | "wide" | "phone";

/** Where a header being dragged stands in the column: the one lifted, or the line a drop would land on. */
export type TrackReorder = "lifted" | "before" | "after";

const TRACK_LEVEL_MIN_DB = -60;
const TRACK_LEVEL_MAX_DB = 12;
const LEVEL_STEP_DB = 0.5;

/** `data-*` attributes (a presence anchor) the host wants on the header's elements. */
export type TrackHeaderAttrs = Readonly<Record<string, string>>;

export type TrackHeaderProps = {
  /** The track's id, first argument of every callback so one function serves every header. */
  id: string;
  name: string;
  /** Index into the eight presence colours; the track's. */
  colorIndex: number;
  /** 168 px column, the 280 px mixer column, or the 56 px phone column with the avatar alone. */
  form?: TrackHeaderForm;
  /** How the track reads for this listener: muted in the mix, for them alone, silent because another track is soloed, or audible. */
  mute?: MuteState;
  solo?: boolean;
  /** Gain in dB. */
  level: number;
  /** The live playback level, 0 to 1, in the avatar's ring and the wide form's meter. */
  playing?: number;
  /** The track's stem is being rebuilt: a hollow ring on the avatar. */
  rebuilding?: boolean;
  /** The track clipped in playback and its light is still lit: a danger ring and a badge on the avatar. */
  clipped?: boolean;
  /** Why the track reads as it does, such as the reasons a stem is out of date: spoken with the other facts and shown as the select button's tip. */
  status?: string;
  selected?: boolean;
  reorder?: TrackReorder;
  /** Attributes for the header, and for its Mute and Solo buttons, such as presence anchors. */
  anchorProps?: {
    header?: TrackHeaderAttrs;
    mute?: TrackHeaderAttrs;
    solo?: TrackHeaderAttrs;
  };
  /** A guest hears the mix but cannot change it: the level is fixed and a mix mute stays on. */
  readOnly?: boolean;
  /** `additive` is Shift, Ctrl or Cmd held: add the track to the selection. */
  onSelect: (id: string, additive: boolean) => void;
  onMute: (id: string) => void;
  onSolo: (id: string) => void;
  /** A drag, key press or typed value on the level; one gesture is one call. */
  onLevel: (id: string, db: number) => void;
  /** Shift with Up or Down on the select button: move the track one place. */
  onMove?: (id: string, direction: -1 | 1) => void;
  /**
   * A native drag from anywhere on the header except its controls reorders;
   * the column owns the drop.
   */
  onDragStart?: (id: string, event: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: (id: string, event: DragEvent<HTMLDivElement>) => void;
};

const MUTE_TIPS: Record<MuteState, string> = {
  saved: "Unmute. Muted in the mix, for everyone and every export",
  listen: "Unmute. Muted for you only",
  implied:
    "Mute. Not muted: silent because you soloed another track, and only you hear it that way",
  off: "Mute",
};
const MUTE_GUEST_TIP =
  "Muted in the mix. Only the host and editors can unmute it";

export const TrackHeader = memo(function TrackHeader({
  id,
  name,
  colorIndex,
  form = "default",
  mute = "off",
  solo = false,
  level,
  playing = 0,
  rebuilding = false,
  clipped = false,
  status,
  selected = false,
  reorder,
  anchorProps,
  readOnly = false,
  onSelect,
  onMute,
  onSolo,
  onLevel,
  onMove,
  onDragStart,
  onDragEnd,
}: TrackHeaderProps) {
  const statusId = useId();
  const muted = mute === "saved" || mute === "listen";
  const facts = [
    mute === "saved" ? "Muted in the mix" : null,
    mute === "listen" ? "Muted for you only" : null,
    mute === "implied" ? "Silent while another track is soloed" : null,
    solo ? "Soloed" : null,
    rebuilding ? "Rebuilding" : null,
    clipped ? "Clipped in playback" : null,
    status ?? null,
  ].filter((fact) => fact !== null);
  const isSet = mute !== "off" || solo || level !== 0;
  const phone = form === "phone";
  const fromControl = useRef(false);
  const commitLevel = useStableCallback((db: number) => onLevel(id, db));

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!event.shiftKey || !onMove) return;
    const direction =
      event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    event.stopPropagation();
    onMove(id, direction);
  };
  const dragStart = (event: DragEvent<HTMLDivElement>) => {
    if (fromControl.current) {
      event.preventDefault();
      return;
    }
    onDragStart?.(id, event);
  };

  return (
    <div
      className="sys-track"
      {...anchorProps?.header}
      draggable={onDragStart ? true : undefined}
      onPointerDown={(event) => {
        fromControl.current =
          (event.target as Element).closest(".sys-track-controls") !== null;
      }}
      onDragStart={onDragStart ? dragStart : undefined}
      onDragEnd={onDragEnd ? (event) => onDragEnd(id, event) : undefined}
      data-form={form}
      data-selected={selected || undefined}
      data-mute={mute}
      data-solo={solo || undefined}
      data-set={isSet || undefined}
      data-rebuilding={rebuilding || undefined}
      data-clipped={clipped || undefined}
      data-reorder={reorder}
      style={
        {
          "--sys-track-color": presenceColorVar(colorIndex),
          "--sys-track-level": clamp(playing, 0, 1),
        } as CSSProperties
      }
    >
      <button
        type="button"
        className="sys-track-main"
        aria-pressed={selected}
        aria-describedby={facts.length > 0 ? statusId : undefined}
        title={status}
        onClick={(event) =>
          onSelect(id, event.shiftKey || event.ctrlKey || event.metaKey)
        }
        onKeyDown={onKeyDown}
      >
        <span className="sys-track-avatar">
          <PersonAvatar person={{ name, colorIndex }} size={28} />
          {clipped || (phone && (muted || solo)) ? (
            <span className="sys-track-badge">
              <SystemIcon
                name={
                  clipped ? "triangle-alert" : muted ? "volume-x" : "headphones"
                }
                size={12}
              />
            </span>
          ) : null}
        </span>
        <span className={phone ? "sr-only" : "sys-track-name"}>{name}</span>
      </button>
      {facts.length > 0 ? (
        <span id={statusId} className="sr-only">
          {facts.join(". ")}
        </span>
      ) : null}
      {phone ? null : (
        <div className="sys-track-controls">
          <button
            type="button"
            className="sys-track-toggle"
            data-kind="mute"
            {...anchorProps?.mute}
            data-state={mute}
            aria-pressed={muted}
            aria-disabled={readOnly && mute === "saved" ? true : undefined}
            aria-label={`Mute ${name}`}
            title={
              readOnly && mute === "saved" ? MUTE_GUEST_TIP : MUTE_TIPS[mute]
            }
            onClick={
              readOnly && mute === "saved" ? undefined : () => onMute(id)
            }
          >
            <SystemIcon name="volume-x" size={16} />
          </button>
          <button
            type="button"
            className="sys-track-toggle"
            data-kind="solo"
            {...anchorProps?.solo}
            aria-pressed={solo}
            aria-label={`Solo ${name}`}
            title={
              solo
                ? "Unsolo. Soloed for you only"
                : "Solo. Solos the track for you only"
            }
            onClick={() => onSolo(id)}
          >
            <SystemIcon name="headphones" size={16} />
          </button>
          <ScrubField
            variant="level"
            label={`${name} level`}
            unit="dB"
            min={TRACK_LEVEL_MIN_DB}
            max={TRACK_LEVEL_MAX_DB}
            step={LEVEL_STEP_DB}
            defaultValue={0}
            value={level}
            readOnly={readOnly}
            onCommit={commitLevel}
          />
          {form === "wide" ? (
            <span className="sys-track-meter" aria-hidden="true">
              <span />
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
});
