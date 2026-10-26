import type { CSSProperties } from "react";
import { initials, presenceColorVar } from "../presence/colors";
import { PERSON_STATES, type PersonTileState } from "./personStates";
import { SystemIcon } from "./SystemIcon";

export type PersonData = {
  name: string;
  /** Index into the eight presence colours. */
  colorIndex: number;
};

export type PersonAvatarSize = 20 | 24 | 28 | 32;

export type PersonAvatarProps = {
  person: PersonData;
  size?: PersonAvatarSize;
  /**
   * `true` when the name is printed beside the avatar (the usual case): the
   * avatar is hidden from assistive tech. `false` names it on its own.
   */
  decorative?: boolean;
};

/** Initials on the person's colour. The colour is never the only cue: the name is printed too. */
export function PersonAvatar({
  person,
  size = 24,
  decorative = true,
}: PersonAvatarProps) {
  return (
    <span
      className={`sys-person-avatar sys-person-avatar--${size}`}
      style={
        {
          "--sys-person-color": presenceColorVar(person.colorIndex),
        } as CSSProperties
      }
      aria-hidden={decorative ? true : undefined}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : person.name}
    >
      {initials(person.name)}
    </span>
  );
}

export type PersonTileProps =
  | {
      person: PersonData;
      state: PersonTileState;
    }
  | {
      /** The empty tile: the only form that is a button. */
      person?: undefined;
      onInvite: () => void;
    };

/** One person in the room: avatar, name and a state in words. Empty, it invites. */
export function PersonTile(props: PersonTileProps) {
  if (props.person === undefined) {
    return (
      <button
        type="button"
        className="sys-person-tile sys-person-tile--empty"
        onClick={props.onInvite}
      >
        <SystemIcon name="user-plus" size={20} />
        <span>Invite</span>
      </button>
    );
  }
  const { person, state } = props;
  const entry = PERSON_STATES[state];
  return (
    <div className="sys-person-tile" data-state={state}>
      <PersonAvatar person={person} size={32} />
      <span className="sys-person-name">{person.name}</span>
      <span className={`sys-person-state sys-person-state--${entry.tone}`}>
        <SystemIcon
          name={entry.icon}
          size={14}
          progress={state === "saving" ? 0.4 : undefined}
        />
        {entry.text}
      </span>
    </div>
  );
}
