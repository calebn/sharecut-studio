import type { SessionClient } from "../types/session";
import { plural } from "../utils/format";
import { isGuestClientId, isLocalPresenceClient } from "./followSync";

const NON_PERSON_ROLES = new Set(["agent", "cli"]);

/** Share guests carry the guest client-id prefix with role `viewer`; `guest` is the authz role. */
export function isGuestPresenceClient(
  client: Pick<SessionClient, "client_id" | "role">,
): boolean {
  return client.role === "guest" || isGuestClientId(client.client_id);
}

function count(n: number, noun: string): string {
  return `${n} ${plural(n, noun)}`;
}

/** Status-bar roster: "You", "You + 2 guests", "You + 1 host + 1 guest · 1 agent". */
export function presenceSummary(
  clients: readonly SessionClient[],
  localClientId: string | null,
): string {
  let hosts = 0;
  let guests = 0;
  let agents = 0;
  for (const c of clients) {
    if (isLocalPresenceClient(c.client_id, localClientId)) {
      continue;
    }
    if (NON_PERSON_ROLES.has(c.role)) {
      agents += 1;
    } else if (isGuestPresenceClient(c)) {
      guests += 1;
    } else {
      hosts += 1;
    }
  }
  const people = ["You"];
  if (hosts > 0) {
    people.push(count(hosts, "host"));
  }
  if (guests > 0) {
    people.push(count(guests, "guest"));
  }
  const label = people.join(" + ");
  return agents > 0 ? `${label} · ${count(agents, "agent")}` : label;
}
