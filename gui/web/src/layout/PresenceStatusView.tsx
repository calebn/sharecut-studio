import { presenceSummary } from "../presence/presenceSummary";
import type { SessionClient } from "../types/session";

/** Props-only presence chip, so the status bar can preview it without the store. */
export function PresenceStatusView({
  narrow,
  clients,
  localClientId,
}: {
  narrow: boolean;
  clients: SessionClient[];
  localClientId: string | null;
}) {
  if (clients.length === 0) {
    return null;
  }
  return (
    <span
      className={narrow ? "status-bar-secondary" : undefined}
      title={clients
        .map(
          (c) =>
            `${c.meta?.display_name || c.label || c.client_id} (${c.role})`,
        )
        .join(", ")}
    >
      Presence: {presenceSummary(clients, localClientId)}
    </span>
  );
}
