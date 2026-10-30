import { renderHook } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../../../state/dawStore";
import { useScriptLateFailure } from "./useScriptLateFailure";

const failure = (projectPath: string) => ({
  projectPath,
  trackId: "t1",
  sourceId: null,
  wordIndex: 3,
  originalText: "hello",
  message: "Could not ignore “hello”: offline",
});

describe("useScriptLateFailure", () => {
  beforeEach(() => {
    useDawStore.setState({
      projectPath: "/p/a.sharecut",
      transcriptInlineEditFailure: null,
      statusAnnouncement: "",
    });
  });

  it("announces a late failure once and clears it", () => {
    renderHook(() => useScriptLateFailure());
    act(() => {
      useDawStore
        .getState()
        .setTranscriptInlineEditFailure(failure("/p/a.sharecut"));
    });
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Could not ignore “hello”: offline",
    );
    expect(useDawStore.getState().transcriptInlineEditFailure).toBeNull();
  });

  it("drops a failure from another project without saying it", () => {
    renderHook(() => useScriptLateFailure());
    act(() => {
      useDawStore
        .getState()
        .setTranscriptInlineEditFailure(failure("/p/b.sharecut"));
    });
    expect(useDawStore.getState().statusAnnouncement).toBe("");
    expect(useDawStore.getState().transcriptInlineEditFailure).toBeNull();
  });
});
