import { memo } from "react";
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
    sessionClients: s.sessionClients,
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
