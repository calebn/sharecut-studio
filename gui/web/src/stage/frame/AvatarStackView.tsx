import { useState } from "react";
import { rosterDisplayName } from "../../presence/colors";
import type { SessionClient } from "../../types/session";
import { Avatar } from "../../ui/Avatar";
import { Menu, MenuItem, MenuSection } from "../../ui/Menu";
import { overflowLabel } from "../../utils/format";

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
  /**
   * `inline`: the status bar's avatars. `menu`: a People section inside a menu
   * that is already open. `popup`: its own menu behind a People button.
   * `header`: the App header's people slot, avatars as one button that opens the
   * Follow menu; the phone shows one avatar and a count.
   */
  variant?: "inline" | "menu" | "popup" | "header";
  /** Class for the `popup` variant's button, so the host row can style it. */
  triggerClassName?: string;
  others: readonly SessionClient[];
  self?: SessionClient;
  names: ReadonlyMap<string, string>;
  followingClientId: string | null;
  onFollow: (id: string) => void;
};

/** Props-only avatar stack, shared by the desktop status bar and the People menu. */
export function AvatarStackView({
  variant = "inline",
  triggerClassName,
  others,
  self,
  names,
  followingClientId,
  onFollow,
}: Props) {
  const [moreOpen, setMoreOpen] = useState(false);

  if (variant === "header") {
    if (others.length === 0 && (self?.followers ?? 0) === 0) {
      return null;
    }
    const shownOthers = others.slice(0, 3);
    return (
      <div className="avatar-header">
        {others.length > 0 ? (
          <Menu
            open={moreOpen}
            onOpenChange={setMoreOpen}
            label="People"
            className="ui-menu-root sys-menu avatar-header-menu"
            trigger={(t) => (
              <button
                type="button"
                className="avatar-header-trigger"
                {...t}
                aria-label={`People here, ${others.length}. Follow someone`}
                title="People here"
              >
                <span className="avatar-header-faces" aria-hidden="true">
                  {shownOthers.map((c) => (
                    <Avatar
                      key={c.client_id}
                      name={names.get(c.client_id) ?? rosterDisplayName(c)}
                      colorIndex={c.meta?.color_index}
                      sessionRole={c.role}
                      size="sm"
                      decorative
                      ring={
                        followingClientId === c.client_id ? "solid" : "none"
                      }
                    />
                  ))}
                </span>
                {others.length > 3 ? (
                  <span
                    className="avatar-header-extra"
                    aria-hidden="true"
                    data-count={others.length - 3}
                  />
                ) : null}
                {others.length > 1 ? (
                  <span
                    className="avatar-header-phone-count"
                    aria-hidden="true"
                    data-count={others.length - 1}
                  />
                ) : null}
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

  if (variant === "popup") {
    if (others.length === 0) {
      return null;
    }
    return (
      <Menu
        open={moreOpen}
        onOpenChange={setMoreOpen}
        label="People"
        trigger={(t) => (
          <button
            type="button"
            className={triggerClassName ?? "ui-control"}
            {...t}
          >
            People · {others.length}
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
    );
  }

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
        const followLabel =
          followingClientId === c.client_id
            ? `Stop following ${name}`
            : `Follow ${name}`;
        return (
          <button
            key={c.client_id}
            type="button"
            className="ui-control avatar-stack-btn"
            aria-pressed={followingClientId === c.client_id}
            aria-label={followLabel}
            title={followLabel}
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
