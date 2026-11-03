import { describe, expect, it } from "vitest";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import { hostRecordsMic, someoneAccepted } from "./hostRecording";

const host = (consented: boolean | null) =>
  recordParticipant({ participant_id: "p_host", role: "host", consented });

describe("hostRecordsMic", () => {
  it("is on before a snapshot, with no host row, and while the host accepted or has not answered", () => {
    expect(hostRecordsMic(null)).toBe(true);
    expect(hostRecordsMic(recordSnapshot())).toBe(true);
    expect(hostRecordsMic(recordSnapshot({ participants: [host(true)] }))).toBe(
      true,
    );
    expect(hostRecordsMic(recordSnapshot({ participants: [host(null)] }))).toBe(
      true,
    );
  });

  it("is off once the host declined their own recording", () => {
    expect(
      hostRecordsMic(recordSnapshot({ participants: [host(false)] })),
    ).toBe(false);
  });
});

describe("someoneAccepted", () => {
  it("counts a connected host or guest who accepted, not a declined or removed one", () => {
    expect(
      someoneAccepted(recordSnapshot({ participants: [host(false)] })),
    ).toBe(false);
    expect(
      someoneAccepted(
        recordSnapshot({
          participants: [host(false), recordParticipant({ removed: true })],
        }),
      ),
    ).toBe(false);
    expect(
      someoneAccepted(
        recordSnapshot({ participants: [host(false), recordParticipant()] }),
      ),
    ).toBe(true);
  });
});
