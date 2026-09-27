import { memo } from "react";
import { presenceSummary } from "../presence/presenceSummary";
import { useDaw } from "../state/useDaw";

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
  if (sessionClients.length === 0) {
    return null;
  }
  return (
    <span
      className={narrow ? "status-bar-secondary" : undefined}
      title={sessionClients
        .map(
          (c) =>
            `${c.meta?.display_name || c.label || c.client_id} (${c.role})`,
        )
        .join(", ")}
    >
      Presence: {presenceSummary(sessionClients, localClientId)}
    </span>
  );
});
