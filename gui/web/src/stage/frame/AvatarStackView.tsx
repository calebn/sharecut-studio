import { type CSSProperties, useRef, useState } from "react";
import { presenceColorVar, rosterDisplayName } from "../../presence/colors";
import { PersonAvatar } from "../../system/Person";
import { SystemIcon } from "../../system/SystemIcon";
import { STAGES } from "../../system/verbs";
import type { SessionClient } from "../../types/session";
import { Avatar } from "../../ui/Avatar";
import { Menu, MenuItem, MenuSection } from "../../ui/Menu";
import { Pill } from "../../ui/Pill";
import { overflowLabel } from "../../utils/format";
import {
  cardLabel,
  cardWhere,
  type PersonCard,
  type PresenceViewer,
  personCard,
} from "./personCard";

const noop = () => undefined;

type Handlers = {
  onFollow: (id: string) => void;
  onGoTo?: (id: string) => void;
};

function colorStyle(colorIndex: number): CSSProperties {
  return {
    "--sys-person-color": presenceColorVar(colorIndex),
  } as CSSProperties;
}

function stageIcon(stage: PersonCard["badge"]) {
  return STAGES.find((s) => s.id === stage)?.icon ?? "circle";
}

function PersonRows({
  card,
  onFollow,
  onGoTo,
  onSelect,
}: Handlers & { card: PersonCard; onSelect: () => void }) {
  return (
    <>
      <div className="avatar-card-head" aria-hidden="true">
        <span className="avatar-card-name">{card.name}</span>
        <span className="avatar-card-meta">{cardWhere(card)}</span>
      </div>
      <MenuItem
        onSelect={() => {
          onFollow(card.id);
          onSelect();
        }}
      >
        <SystemIcon name={card.following ? "eye-off" : "eye"} size={16} />
        {card.following ? "Stop following" : "Follow"}
      </MenuItem>
      {card.goTo && onGoTo ? (
        <MenuItem
          onSelect={() => {
            onGoTo(card.id);
            onSelect();
          }}
        >
          <SystemIcon name="arrow-right" size={16} />
          Go to where they are
        </MenuItem>
      ) : null}
    </>
  );
}

function PersonFace({
  card,
  handlers,
}: {
  card: PersonCard;
  handlers: Handlers;
}) {
  const [open, setOpen] = useState(false);
  const label = cardLabel(card);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label={label}
      className="ui-menu-root sys-menu avatar-header-menu avatar-face-root"
      trigger={(t) => (
        <button
          type="button"
          className="avatar-face"
          {...t}
          aria-label={label}
          title={label}
          data-following={card.following || undefined}
          data-person={card.id}
          style={colorStyle(card.colorIndex)}
        >
          <PersonAvatar
            person={{ name: card.name, colorIndex: card.colorIndex }}
            size={24}
            drawn
          />
          {card.badge ? (
            <span className="avatar-face-badge" aria-hidden="true">
              <SystemIcon name={stageIcon(card.badge)} size={12} />
            </span>
          ) : null}
        </button>
      )}
    >
      <PersonRows {...handlers} card={card} onSelect={() => setOpen(false)} />
    </Menu>
  );
}

function MoreFaces({
  cards,
  handlers,
  className,
}: {
  cards: readonly PersonCard[];
  handlers: Handlers;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  if (cards.length === 0) return null;
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label="More people"
      className={`ui-menu-root sys-menu avatar-header-menu ${className}`}
      trigger={(t) => (
        <button
          type="button"
          className="avatar-more"
          {...t}
          aria-label={overflowLabel(cards.length)}
          title={overflowLabel(cards.length)}
          data-count={cards.length}
        />
      )}
    >
      {cards.map((card) => (
        <div
          key={card.id}
          className="avatar-card"
          role="group"
          aria-label={cardLabel(card)}
        >
          <PersonRows
            {...handlers}
            card={card}
            onSelect={() => setOpen(false)}
          />
        </div>
      ))}
    </Menu>
  );
}

function FollowingPill({
  card,
  onUnfollow,
}: {
  card: PersonCard;
  onUnfollow: () => void;
}) {
  return (
    <span className="avatar-follow" style={colorStyle(card.colorIndex)}>
      <Pill className="avatar-follow-pill">
        <SystemIcon name="locate-fixed" size={12} />
        <span className="avatar-follow-text">Following {card.name}</span>
        <button
          type="button"
          className="sys-pill-x avatar-follow-x"
          aria-label={`Stop following ${card.name}`}
          title="Stop following"
          onClick={onUnfollow}
        >
          <SystemIcon name="x" size={12} />
        </button>
      </Pill>
    </span>
  );
}

function FollowersBadge({
  self,
  names,
}: {
  self: SessionClient;
  names: ReadonlyMap<string, string>;
}) {
  return (
    <span
      className="avatar-stack-followers"
      role="img"
      aria-label={`${self.followers} following you`}
    >
      <span aria-hidden>
        <Avatar
          name={names.get(self.client_id) ?? rosterDisplayName(self)}
          colorIndex={self.meta?.color_index}
          sessionRole={self.role}
          ring="dashed"
          badge={self.followers}
        />
      </span>
    </span>
  );
}

type Props = {
  variant?: "menu" | "header";
  others: readonly SessionClient[];
  self?: SessionClient;
  names: ReadonlyMap<string, string>;
  followingClientId: string | null;
  onFollow: (id: string) => void;
  onUnfollow?: () => void;
  onGoTo?: (id: string) => void;
  viewer?: PresenceViewer;
};

export function AvatarStackView({
  variant = "header",
  others,
  self,
  names,
  followingClientId,
  onFollow,
  onUnfollow,
  onGoTo,
  viewer,
}: Props) {
  const root = useRef<HTMLDivElement>(null);
  const cards = others.map((c) =>
    personCard(c, names, viewer, followingClientId),
  );

  if (variant === "menu") {
    if (cards.length === 0) {
      return null;
    }
    return (
      <MenuSection label="People">
        {cards.map((card) => (
          <div
            key={card.id}
            className="avatar-card"
            role="group"
            aria-label={cardLabel(card)}
          >
            <PersonRows
              onFollow={onFollow}
              onGoTo={onGoTo}
              card={card}
              onSelect={noop}
            />
          </div>
        ))}
      </MenuSection>
    );
  }

  if (cards.length === 0 && (self?.followers ?? 0) === 0) {
    return null;
  }
  const handlers: Handlers = { onFollow, onGoTo };
  const followed = cards.find((card) => card.following);
  return (
    <div className="avatar-header" ref={root}>
      {cards.length > 0 ? (
        <div className="avatar-faces" role="group" aria-label="People here">
          {cards.slice(0, 3).map((card) => (
            <PersonFace key={card.id} card={card} handlers={handlers} />
          ))}
          <MoreFaces
            cards={cards.slice(3)}
            handlers={handlers}
            className="avatar-more-root"
          />
          <MoreFaces
            cards={cards.slice(1)}
            handlers={handlers}
            className="avatar-phone-root"
          />
        </div>
      ) : null}
      {followed ? (
        <FollowingPill
          card={followed}
          onUnfollow={() => {
            (onUnfollow ?? (() => onFollow(followed.id)))();
            requestAnimationFrame(() => {
              const faces =
                root.current?.querySelectorAll<HTMLElement>(".avatar-face");
              const own = Array.from(faces ?? []).find(
                (face) => face.dataset.person === followed.id,
              );
              (own?.offsetParent ? own : faces?.[0])?.focus();
            });
          }}
        />
      ) : null}
      {self && (self.followers ?? 0) > 0 ? (
        <FollowersBadge self={self} names={names} />
      ) : null}
    </div>
  );
}
