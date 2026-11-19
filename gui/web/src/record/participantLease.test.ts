import { describe, expect, it } from "vitest";
import {
  leaseKnownYoungEnough,
  REJOIN_LEASE_MAX_AGE_MS,
  stampLease,
} from "./participantLease";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 19, 12);

describe("leaseKnownYoungEnough", () => {
  it("allows a lease minted five days ago", () => {
    expect(
      leaseKnownYoungEnough(
        { participant_id: "p", lease: "l", issuedAt: NOW - 5 * DAY },
        NOW,
      ),
    ).toBe(true);
  });

  it("refuses a lease older than six days", () => {
    expect(REJOIN_LEASE_MAX_AGE_MS).toBe(6 * DAY);
    expect(
      leaseKnownYoungEnough(
        { participant_id: "p", lease: "l", issuedAt: NOW - 6 * DAY - 1 },
        NOW,
      ),
    ).toBe(false);
    expect(
      leaseKnownYoungEnough(
        { participant_id: "p", lease: "l", issuedAt: NOW - 6 * DAY },
        NOW,
      ),
    ).toBe(true);
  });

  it("refuses an entry with no issue time", () => {
    expect(
      leaseKnownYoungEnough({ participant_id: "p", lease: "l" }, NOW),
    ).toBe(false);
  });

  it("refuses no entry, and an issue time in the future", () => {
    expect(leaseKnownYoungEnough(undefined, NOW)).toBe(false);
    expect(
      leaseKnownYoungEnough(
        { participant_id: "p", lease: "l", issuedAt: NOW + DAY },
        NOW,
      ),
    ).toBe(false);
  });
});

describe("stampLease", () => {
  it("stamps a lease the server newly minted", () => {
    expect(
      stampLease(undefined, { participant_id: "p", lease: "new" }, NOW),
    ).toEqual({ participant_id: "p", lease: "new", issuedAt: NOW });
    expect(
      stampLease(
        { participant_id: "p", lease: "old", issuedAt: NOW - DAY },
        { participant_id: "p", lease: "new" },
        NOW,
      ),
    ).toEqual({ participant_id: "p", lease: "new", issuedAt: NOW });
  });

  it("keeps the old issue time when the server echoes the same lease", () => {
    expect(
      stampLease(
        { participant_id: "p", lease: "same", issuedAt: NOW - 5 * DAY },
        { participant_id: "p", lease: "same" },
        NOW,
      ),
    ).toEqual({ participant_id: "p", lease: "same", issuedAt: NOW - 5 * DAY });
  });

  it("leaves an entry with no issue time unstamped when the lease is the same", () => {
    expect(
      stampLease(
        { participant_id: "p", lease: "same" },
        { participant_id: "p", lease: "same" },
        NOW,
      ),
    ).toEqual({ participant_id: "p", lease: "same" });
  });
});
