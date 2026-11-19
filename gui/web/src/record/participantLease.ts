import type { RecordParticipantLease } from "../services/offlineQueue/offlineStore";

const DAY_MS = 24 * 60 * 60 * 1000;

export const REJOIN_LEASE_MAX_AGE_MS = 6 * DAY_MS;

export function leaseKnownYoungEnough(
  entry: RecordParticipantLease | undefined,
  now: number,
): boolean {
  const issuedAt = entry?.issuedAt;
  return (
    issuedAt !== undefined &&
    issuedAt <= now &&
    now - issuedAt <= REJOIN_LEASE_MAX_AGE_MS
  );
}

export function msUntilLeaseStale(
  entry: RecordParticipantLease | undefined,
  now: number,
): number | null {
  if (!leaseKnownYoungEnough(entry, now) || entry?.issuedAt === undefined) {
    return null;
  }
  return entry.issuedAt + REJOIN_LEASE_MAX_AGE_MS - now + 1;
}

export function stampLease(
  cached: RecordParticipantLease | undefined,
  minted: { participant_id: string; lease: string },
  now: number,
): RecordParticipantLease {
  if (
    cached?.lease === minted.lease &&
    cached.participant_id === minted.participant_id
  ) {
    return cached.issuedAt === undefined
      ? { ...minted }
      : { ...minted, issuedAt: cached.issuedAt };
  }
  return { ...minted, issuedAt: now };
}
