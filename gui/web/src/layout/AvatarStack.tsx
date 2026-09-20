import { useMemo, useState } from "react";
import { execute } from "../commands/execute";
import { disambiguatedNames, rosterDisplayName } from "../presence/colors";
import {
  isLocalPresenceClient,
  remotePresenceClients,
  serverNowMs,
} from "../presence/followSync";
import { useDawStore } from "../state/dawStore";
import type { SessionClient } from "../types/session";
import { Avatar } from "../ui/Avatar";
import { Menu, MenuItem, MenuSection } from "../ui/Menu";

type Props = {
  variant?: "inline" | "menu";
};

function liveOthers(
  clients: SessionClient[],
  localId: string | null,
  offsetMs: number,
): SessionClient[] {
  return remotePresenceClients(clients, localId, serverNowMs(offsetMs));
}

function localClient(
  clients: SessionClient[],
  localId: string | null,
): SessionClient | undefined {
  return clients.find((c) => isLocalPresenceClient(c.client_id, localId));
}

function follow(clientId: string): void {
  void execute("presence.follow", { clientId });
}

function PeopleList({
  others,
  names,
  followingClientId,
  onSelect,
}: {
  others: SessionClient[];
  names: Map<string, string>;
  followingClientId: string | null;
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
              follow(c.client_id);
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

export function AvatarStack({ variant = "inline" }: Props) {
  const sessionClients = useDawStore((s) => s.sessionClients);
  const localClientId = useDawStore((s) => s.localClientId);
  const followingClientId = useDawStore((s) => s.followingClientId);
  const offsetMs = useDawStore((s) => s.serverClockOffsetMs);
  const [moreOpen, setMoreOpen] = useState(false);

  const others = useMemo(
    () => liveOthers(sessionClients, localClientId, offsetMs),
    [sessionClients, localClientId, offsetMs],
  );
  const self = localClient(sessionClients, localClientId);
  const names = useMemo(
    () => disambiguatedNames(sessionClients),
    [sessionClients],
  );

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
            onClick={() => follow(c.client_id)}
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
              ref={t.ref}
              aria-expanded={t["aria-expanded"]}
              aria-haspopup={t["aria-haspopup"]}
              aria-controls={t["aria-controls"]}
              aria-label={`+${overflow.length} more`}
              onClick={t.onClick}
            >
              +{overflow.length}
            </button>
          )}
        >
          <PeopleList
            others={others}
            names={names}
            followingClientId={followingClientId}
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
