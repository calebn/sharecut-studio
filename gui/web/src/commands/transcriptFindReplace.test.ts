import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerTranscriptViewCommands } from "./view";

describe("transcript.findReplace", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerTranscriptViewCommands();
    useDawStore.getState().hydrate("/tmp/ep", minimalProject());
  });
  it("opens the transcript form through the shared command bus", async () => {
    expect(
      (await execute("transcript.findReplace", {}, { skipWhen: true })).status,
    ).toBe("ok");
    expect(useDawStore.getState().transcriptFindReplaceOpen).toBe(true);
    expect(useDawStore.getState().activeTab).toBe("transcript");
    await execute("transcript.findReplace", {}, { skipWhen: true });
    expect(useDawStore.getState().transcriptFindReplaceOpen).toBe(false);
  });
  it("denies edit guests and clears open state on project switch", async () => {
    useDawStore
      .getState()
      .hydrate("share:guest", minimalProject(), "edit", ["edit"]);
    expect(
      (await execute("transcript.findReplace", {}, { skipWhen: true })).status,
    ).toBe("disabled");
    expect(useDawStore.getState().transcriptFindReplaceOpen).toBe(false);
  });
});
