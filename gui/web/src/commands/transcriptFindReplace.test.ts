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
    useDawStore.setState({
      layoutMode: "default",
      activeTab: "comments",
      timelineFocused: false,
    });
  });
  it("opens the transcript form through the shared command bus", async () => {
    expect(
      (await execute("transcript.findReplace", {}, { skipWhen: true })).status,
    ).toBe("ok");
    expect(useDawStore.getState().chrome.transcriptFindReplaceOpen).toBe(true);
    expect(useDawStore.getState().activeTab).toBe("transcript");
    await execute("transcript.findReplace", {}, { skipWhen: true });
    expect(useDawStore.getState().chrome.transcriptFindReplaceOpen).toBe(false);
  });
  it.each([
    ["timeline", "default", false],
    ["review", "default", true],
    ["default", "default", true],
    ["text", "text", true],
  ] as const)(
    "reveals Transcript from %s layout and preserves its focus policy",
    async (layoutMode, expectedLayout, expectedFocus) => {
      useDawStore.setState({ layoutMode, timelineFocused: true });
      expect(
        (await execute("transcript.findReplace", {}, { skipWhen: true }))
          .status,
      ).toBe("ok");
      expect(useDawStore.getState()).toMatchObject({
        activeTab: "transcript",
        layoutMode: expectedLayout,
        timelineFocused: expectedFocus,
        chrome: { transcriptFindReplaceOpen: true },
      });
      await execute("transcript.findReplace", {}, { skipWhen: true });
      expect(useDawStore.getState()).toMatchObject({
        layoutMode: expectedLayout,
        chrome: { transcriptFindReplaceOpen: false },
      });
    },
  );
  it("denies a missing host project without revealing panels", async () => {
    useDawStore.setState({
      project: null,
      layoutMode: "timeline",
      timelineFocused: true,
    });
    expect(
      (await execute("transcript.findReplace", {}, { skipWhen: true })).status,
    ).toBe("disabled");
    expect(useDawStore.getState()).toMatchObject({
      layoutMode: "timeline",
      timelineFocused: true,
      activeTab: "comments",
      chrome: { transcriptFindReplaceOpen: false },
    });
  });
  it("denies edit guests and clears open state on project switch", async () => {
    await execute("transcript.findReplace", {}, { skipWhen: true });
    expect(useDawStore.getState().chrome.transcriptFindReplaceOpen).toBe(true);
    useDawStore
      .getState()
      .hydrate("share:guest", minimalProject(), "edit", ["edit"]);
    useDawStore.setState({
      layoutMode: "timeline",
      activeTab: "comments",
      timelineFocused: true,
    });
    expect(
      (await execute("transcript.findReplace", {}, { skipWhen: true })).status,
    ).toBe("disabled");
    expect(useDawStore.getState()).toMatchObject({
      layoutMode: "timeline",
      activeTab: "comments",
      timelineFocused: true,
      chrome: { transcriptFindReplaceOpen: false },
    });
  });
});
