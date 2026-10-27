import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { setChrome } from "../test/chrome";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerTranscriptViewCommands } from "./view";

describe("transcript.findReplace", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerTranscriptViewCommands();
    useDawStore.getState().hydrate("/tmp/ep", minimalProject());
    setChrome({ transcriptFindReplaceOpen: false });
    useDawStore.setState({ stage: "review", timelineFocused: false });
  });
  it("opens the transcript form through the shared command bus", async () => {
    expect(
      (await execute("transcript.findReplace", {}, { skipWhen: true })).status,
    ).toBe("ok");
    expect(useDawStore.getState().chrome.transcriptFindReplaceOpen).toBe(true);
    expect(useDawStore.getState().stage).toBe("edit");
    await execute("transcript.findReplace", {}, { skipWhen: true });
    expect(useDawStore.getState().chrome.transcriptFindReplaceOpen).toBe(false);
  });
  it.each([
    ["review", true],
    ["review", false],
    ["deliver", true],
    ["edit", true],
  ] as const)(
    "reveals the Script from %s with it hidden=%s",
    async (stage, scriptCollapsed) => {
      useDawStore.setState({ stage, scriptCollapsed });
      expect(
        (await execute("transcript.findReplace", {}, { skipWhen: true }))
          .status,
      ).toBe("ok");
      expect(useDawStore.getState()).toMatchObject({
        stage: "edit",
        scriptCollapsed: false,
        chrome: { transcriptFindReplaceOpen: true },
      });
      await execute("transcript.findReplace", {}, { skipWhen: true });
      expect(useDawStore.getState()).toMatchObject({
        stage: "edit",
        chrome: { transcriptFindReplaceOpen: false },
      });
    },
  );
  it("denies a missing host project without revealing panels", async () => {
    useDawStore.setState({
      project: null,
      timelineFocused: true,
    });
    expect(
      (await execute("transcript.findReplace", {}, { skipWhen: true })).status,
    ).toBe("disabled");
    expect(useDawStore.getState()).toMatchObject({
      timelineFocused: true,
      stage: "review",
      chrome: { transcriptFindReplaceOpen: false },
    });
  });
  it("denies edit guests and clears open state on project switch", async () => {
    await execute("transcript.findReplace", {}, { skipWhen: true });
    expect(useDawStore.getState().chrome.transcriptFindReplaceOpen).toBe(true);
    useDawStore
      .getState()
      .hydrate("share:guest", minimalProject(), "edit", ["edit"]);
    useDawStore.setState({ stage: "review", timelineFocused: true });
    expect(
      (await execute("transcript.findReplace", {}, { skipWhen: true })).status,
    ).toBe("disabled");
    expect(useDawStore.getState()).toMatchObject({
      stage: "review",
      timelineFocused: true,
      chrome: { transcriptFindReplaceOpen: false },
    });
  });
});
