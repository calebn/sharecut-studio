import { useMemo } from "react";
import { execute } from "../commands/execute";
import { disambiguatedNames } from "../presence/colors";
import {
  isLocalPresenceClient,
  remotePresenceClients,
  serverNowMs,
} from "../presence/followSync";
import { useDawStore } from "../state/dawStore";
import type { SessionClient } from "../types/session";
import { AvatarStackView } from "./AvatarStackView";

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

export function AvatarStack({ variant = "inline" }: Props) {
  const sessionClients = useDawStore((s) => s.sessionClients);
  const localClientId = useDawStore((s) => s.localClientId);
  const followingClientId = useDawStore((s) => s.followingClientId);
  const offsetMs = useDawStore((s) => s.serverClockOffsetMs);

  const others = useMemo(
    () => liveOthers(sessionClients, localClientId, offsetMs),
    [sessionClients, localClientId, offsetMs],
  );
  const self = localClient(sessionClients, localClientId);
  const names = useMemo(
    () => disambiguatedNames(sessionClients),
    [sessionClients],
  );

  return (
    <AvatarStackView
      variant={variant}
      others={others}
      self={self}
      names={names}
      followingClientId={followingClientId}
      onFollow={follow}
    />
  );
}
