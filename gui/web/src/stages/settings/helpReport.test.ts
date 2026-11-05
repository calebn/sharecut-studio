import { describe, expect, it } from "vitest";
import {
  DESCRIBE_FIRST,
  referenceOf,
  sendBlockedReason,
  sizeLabel,
  supportLink,
} from "./helpReport";

describe("referenceOf", () => {
  it("shortens the relay's report id to a reference a person can read out", () => {
    expect(
      referenceOf("https://relay.example.test/api/reports/Ab3dEf9hJk2mNp4qRs"),
    ).toBe("R-Ab3dEf9h");
  });

  it("ignores a query string and a trailing slash", () => {
    expect(referenceOf("https://r.test/api/reports/abc123?x=1")).toBe(
      "R-abc123",
    );
    expect(referenceOf("https://r.test/api/reports/abc123/")).toBe("R-abc123");
  });
});

describe("sendBlockedReason", () => {
  it("asks for the problem until there are ten characters", () => {
    expect(sendBlockedReason("")).toBe(DESCRIBE_FIRST);
    expect(sendBlockedReason("   too short ")).toBe(DESCRIBE_FIRST);
    expect(sendBlockedReason("Export hangs at 40%")).toBeUndefined();
  });
});

describe("sizeLabel", () => {
  it("reads in bytes, KB and MB", () => {
    expect(sizeLabel(900)).toBe("900 B");
    expect(sizeLabel(48_300)).toBe("47.2 KB");
    expect(sizeLabel(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("supportLink", () => {
  it("fills the GitHub bug form with the description and version", () => {
    expect(
      supportLink(
        "https://github.com/calebn/sharecut-studio/issues",
        "it hangs",
        "0.1.1",
      ),
    ).toBe(
      "https://github.com/calebn/sharecut-studio/issues/new?template=bug_report.yml&what-happened=it%20hangs&version=0.1.1",
    );
  });

  it("passes any other support page through, and none as none", () => {
    expect(supportLink("https://support.example.test", "x", "1")).toBe(
      "https://support.example.test",
    );
    expect(supportLink(null, "x", "1")).toBeNull();
  });
});
