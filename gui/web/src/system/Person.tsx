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

type PersonAvatarProps = {
  person: PersonData;
  size?: PersonAvatarSize;
};

/** Initials on the person's colour. Hidden from assistive tech: the name is always printed beside it. */
export function PersonAvatar({ person, size = 24 }: PersonAvatarProps) {
  return (
    <span
      className={`sys-person-avatar sys-person-avatar--${size}`}
      style={
        {
          "--sys-person-color": presenceColorVar(person.colorIndex),
        } as CSSProperties
      }
      aria-hidden="true"
    >
      {initials(person.name)}
    </span>
  );
}

type PersonTileProps =
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
