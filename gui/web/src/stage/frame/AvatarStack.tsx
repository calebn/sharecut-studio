import { type ComponentProps, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { execute } from "../../commands/execute";
import { disambiguatedNames } from "../../presence/colors";
import { isLocalPresenceClient } from "../../presence/followSync";
import { sessionClientList } from "../../presence/roster";
import { useLivePresenceClients } from "../../presence/useLivePresenceClients";
import { guestHearsMixOnly } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { stageRoleOf } from "../../state/stageRoutes";
import type { SessionClient } from "../../types/session";
import { AvatarStackView } from "./AvatarStackView";

type Props = Pick<ComponentProps<typeof AvatarStackView>, "variant">;

function localClient(
  clients: SessionClient[],
  localId: string | null,
): SessionClient | undefined {
  return clients.find((c) => isLocalPresenceClient(c.client_id, localId));
}

function follow(clientId: string): void {
  void execute("presence.follow", { clientId });
}

function unfollow(): void {
  void execute("presence.unfollow");
}

function goTo(clientId: string): void {
  void execute("presence.goTo", { clientId });
}

export function AvatarStack({ variant = "header" }: Props) {
  const sessionClients = useDawStore((s) =>
    sessionClientList(s.sessionClients),
  );
  const localClientId = useDawStore((s) => s.localClientId);
  const followingClientId = useDawStore((s) => s.followingClientId);
  const { stage, guestMode, breakpoint, durationSec } = useDawStore(
    useShallow((s) => ({
      stage: s.stage,
      guestMode: s.guestMode,
      breakpoint: s.shellBreakpoint,
      durationSec: s.project?.timeline_duration_sec ?? Number.NaN,
    })),
  );

  const { others } = useLivePresenceClients(sessionClients, localClientId);
  const self = localClient(sessionClients, localClientId);
  const names = useMemo(
    () => disambiguatedNames(sessionClients),
    [sessionClients],
  );
  const viewer = useMemo(
    () => ({
      stage,
      durationSec,
      caps: {
        guestShare: guestHearsMixOnly(guestMode),
        breakpoint,
        role: stageRoleOf(guestMode),
      },
    }),
    [stage, durationSec, guestMode, breakpoint],
  );

  return (
    <AvatarStackView
      variant={variant}
      others={others}
      self={self}
      names={names}
      followingClientId={followingClientId}
      viewer={viewer}
      onFollow={follow}
      onUnfollow={unfollow}
      onGoTo={goTo}
    />
  );
}
