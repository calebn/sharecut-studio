import { describe, expect, it } from "vitest";
import { KEEPER_BYTES_PER_SECOND } from "./keeper/pcm";
import {
  assessStorageHeadroom,
  STORAGE_HEADROOM_SECONDS,
} from "./storageQuota";

describe("assessStorageHeadroom", () => {
  it("warns when estimated free space cannot hold an hour of keeper PCM", () => {
    const result = assessStorageHeadroom({
      usage: 0,
      quota: KEEPER_BYTES_PER_SECOND * (STORAGE_HEADROOM_SECONDS - 1),
    });
    expect(result.status).toBe("low");
    expect(result.message).toMatch(/free space/i);
  });

  it("handles unavailable or malformed estimates without claiming safety", () => {
    expect(assessStorageHeadroom().status).toBe("unknown");
    expect(assessStorageHeadroom({ quota: Number.NaN, usage: 0 }).status).toBe(
      "unknown",
    );
    expect(assessStorageHeadroom({ quota: 10, usage: 20 }).status).toBe("low");
  });

  it("accepts enough headroom", () => {
    expect(
      assessStorageHeadroom({
        usage: 1,
        quota: KEEPER_BYTES_PER_SECOND * STORAGE_HEADROOM_SECONDS + 1,
      }).status,
    ).toBe("sufficient");
  });
});
