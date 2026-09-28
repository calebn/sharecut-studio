import { useMemo } from "react";
import { execute } from "../commands/execute";
import { disambiguatedNames } from "../presence/colors";
import {
  isLocalPresenceClient,
  remotePresenceClients,
} from "../presence/followSync";
import { useServerNowMs } from "../presence/useServerNowMs";
import { useDawStore } from "../state/dawStore";
import type { SessionClient } from "../types/session";
import { AvatarStackView } from "./AvatarStackView";

type Props = {
  variant?: "inline" | "menu";
};

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

  const nowMs = useServerNowMs(sessionClients, localClientId);
  const others = remotePresenceClients(sessionClients, localClientId, nowMs);
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
