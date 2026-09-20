export function presenceColorVar(index: number | undefined): string {
  const n = (((index ?? 0) % 8) + 8) % 8;
  return `var(--presence-${n})`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  const letters = parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "");
  return letters.join("") || "?";
}

export function clientDisplayName(
  label?: string | null,
  fallback = "Guest",
): string {
  const n = (label ?? "").trim();
  return n || fallback;
}

export function rosterDisplayName(client: {
  client_id: string;
  label?: string | null;
  meta?: { display_name?: string | null } | null;
}): string {
  return clientDisplayName(
    client.meta?.display_name || client.label,
    client.client_id,
  );
}

/** Duplicate live names get a ·2 suffix (UI only). */
export function disambiguatedNames(
  clients: Array<{
    client_id: string;
    label?: string | null;
    meta?: { display_name?: string | null } | null;
  }>,
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const c of clients) {
    const n = rosterDisplayName(c);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const c of clients) {
    const n = rosterDisplayName(c);
    if ((counts.get(n) ?? 0) > 1) {
      const k = (seen.get(n) ?? 0) + 1;
      seen.set(n, k);
      out.set(c.client_id, k === 1 ? n : `${n} ·${k}`);
    } else {
      out.set(c.client_id, n);
    }
  }
  return out;
}
