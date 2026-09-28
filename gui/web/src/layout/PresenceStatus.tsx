import { memo } from "react";
import { sessionClientList } from "../presence/roster";
import { useDaw } from "../state/useDaw";
import { PresenceStatusView } from "./PresenceStatusView";

/**
 * Status-bar presence chip leaf. Selects the raw client roster itself, so a
 * presence frame re-renders only this span, not the whole status bar.
 */
export const PresenceStatus = memo(function PresenceStatus({
  narrow,
}: {
  narrow: boolean;
}) {
  const { sessionClients, localClientId } = useDaw((s) => ({
    sessionClients: sessionClientList(s.sessionClients),
    localClientId: s.localClientId,
  }));
  return (
    <PresenceStatusView
      narrow={narrow}
      clients={sessionClients}
      localClientId={localClientId}
    />
  );
});
