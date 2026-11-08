import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleComment } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { ReviewHost } from "./ReviewHost";

function join(role: "comment" | "view", transcriptWordsLoaded: boolean) {
  useDawStore.getState().hydrate(
    "share:tok",
    minimalProject({
      comments: [sampleComment()],
      meta: {
        name: "Test Episode",
        workspace_dir: "/tmp/test",
        hydration: { transcript_words: transcriptWordsLoaded },
      },
    }),
    role,
    role === "comment" ? ["view", "comment", "suggest"] : ["view"],
  );
  useDawStore.setState({ stage: "review" });
}

describe("guest transcript detail loading in Review", () => {
  beforeEach(() => {
    localStorage.clear();
    stubViewportShell("desktop");
  });
  it("keeps the Commenter Queue and composer usable while the Script waits, then shows settled empty copy", () => {
    join("comment", false);
    const { container } = render(<ReviewHost guestShare />);

    expect(screen.getAllByRole("region", { name: "Queue" })[0]).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Comment" })).toBeEnabled();
    expect(
      container.querySelector(".sys-skeleton[aria-busy='true']"),
    ).not.toBeNull();
    expect(
      screen.queryByText("The host has not made a transcript of this version."),
    ).toBeNull();

    act(() => {
      const project = useDawStore.getState().project;
      if (!project) throw new Error("The guest project should be hydrated");
      useDawStore.setState({
        project: {
          ...project,
          meta: { name: "Test Episode", workspace_dir: "/tmp/test" },
        },
      });
    });

    expect(
      screen.getByText("The host has not made a transcript of this version."),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Comment" })).toBeEnabled();
  });

  it("does not show a permanent loading region to a Viewer without timed words", () => {
    join("view", false);
    const { container } = render(<ReviewHost guestShare />);

    expect(screen.getAllByRole("region", { name: "Queue" })[0]).toBeVisible();
    expect(
      container.querySelector(".sys-skeleton[aria-busy='true']"),
    ).toBeNull();
    expect(
      screen.queryByText("The host has not made a transcript of this version."),
    ).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
  });
});
