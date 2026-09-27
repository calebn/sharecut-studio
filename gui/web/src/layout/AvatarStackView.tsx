import { useState } from "react";
import { rosterDisplayName } from "../presence/colors";
import type { SessionClient } from "../types/session";
import { Avatar } from "../ui/Avatar";
import { Menu, MenuItem, MenuSection } from "../ui/Menu";
import { overflowLabel } from "../utils/format";

function PeopleList({
  others,
  names,
  followingClientId,
  onFollow,
  onSelect,
}: {
  others: readonly SessionClient[];
  names: ReadonlyMap<string, string>;
  followingClientId: string | null;
  onFollow: (id: string) => void;
  onSelect?: () => void;
}) {
  return (
    <>
      {others.map((c) => {
        const name = names.get(c.client_id) ?? rosterDisplayName(c);
        return (
          <MenuItem
            key={c.client_id}
            onSelect={() => {
              onFollow(c.client_id);
              onSelect?.();
            }}
          >
            <Avatar
              name={name}
              colorIndex={c.meta?.color_index}
              sessionRole={c.role}
              size="sm"
            />{" "}
            {name}
            {followingClientId === c.client_id ? " · Following" : " · Follow"}
          </MenuItem>
        );
      })}
    </>
  );
}

type Props = {
  variant?: "inline" | "menu";
  others: readonly SessionClient[];
  self?: SessionClient;
  names: ReadonlyMap<string, string>;
  followingClientId: string | null;
  onFollow: (id: string) => void;
};

/** Props-only avatar stack, shared by the desktop status bar and the People menu. */
export function AvatarStackView({
  variant = "inline",
  others,
  self,
  names,
  followingClientId,
  onFollow,
}: Props) {
  const [moreOpen, setMoreOpen] = useState(false);

  if (variant === "menu") {
    if (others.length === 0) {
      return null;
    }
    return (
      <MenuSection label="People">
        <PeopleList
          others={others}
          names={names}
          followingClientId={followingClientId}
          onFollow={onFollow}
        />
      </MenuSection>
    );
  }

  if (others.length === 0 && (self?.followers ?? 0) === 0) {
    return null;
  }

  const shown = others.slice(0, 3);
  const overflow = others.slice(3);

  return (
    <div className="avatar-stack" role="group" aria-label="People in session">
      {shown.map((c) => {
        const name = names.get(c.client_id) ?? rosterDisplayName(c);
        return (
          <button
            key={c.client_id}
            type="button"
            className="ui-control avatar-stack-btn"
            aria-pressed={followingClientId === c.client_id}
            aria-label={
              followingClientId === c.client_id
                ? `Stop following ${name}`
                : `Follow ${name}`
            }
            onClick={() => onFollow(c.client_id)}
          >
            <Avatar
              name={name}
              colorIndex={c.meta?.color_index}
              sessionRole={c.role}
              ring={followingClientId === c.client_id ? "solid" : "none"}
            />
          </button>
        );
      })}
      {overflow.length > 0 ? (
        <Menu
          open={moreOpen}
          onOpenChange={setMoreOpen}
          label="More people"
          trigger={(t) => (
            <button
              type="button"
              className="ui-control avatar-stack-more"
              {...t}
              aria-label={overflowLabel(overflow.length)}
            >
              +{overflow.length}
            </button>
          )}
        >
          <PeopleList
            others={others}
            names={names}
            followingClientId={followingClientId}
            onFollow={onFollow}
            onSelect={() => setMoreOpen(false)}
          />
        </Menu>
      ) : null}
      {self && (self.followers ?? 0) > 0 ? (
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
      ) : null}
    </div>
  );
}
