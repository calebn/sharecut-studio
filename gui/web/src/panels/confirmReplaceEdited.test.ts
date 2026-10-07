import { afterEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { answerQuestions } from "../test/ask";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { confirmReplaceEdited } from "./confirmReplaceEdited";

describe("confirmReplaceEdited", () => {
  afterEach(() => {
    useDawStore.setState({ project: null });
  });

  it("returns false without asking when nothing is edited", async () => {
    const { asked } = answerQuestions(true);
    await expect(confirmReplaceEdited([], "Re-transcribe")).resolves.toBe(
      false,
    );
    expect(asked).toEqual([]);
  });

  it("returns true and names the track by its label when accepted", async () => {
    useDawStore.setState({
      project: minimalProject({
        tracks: [sampleTrack({ id: "host", label: "Ava" })],
      }),
    });
    const { asked } = answerQuestions(true);
    await expect(confirmReplaceEdited(["host"], "Re-time words")).resolves.toBe(
      true,
    );
    expect(asked).toEqual([
      {
        kind: "confirm",
        title: "Replace your transcript edit?",
        message: "Re-time words replaces the hand-edited transcript on Ava.",
        keepLabel: "Keep my edits",
        actionLabel: "Replace transcript",
        danger: true,
      },
    ]);
  });

  it("lists every track in the plural", async () => {
    const { asked } = answerQuestions(true);
    await expect(
      confirmReplaceEdited(["host", "guest"], "Re-transcribe"),
    ).resolves.toBe(true);
    expect(asked[0]).toMatchObject({
      title: "Replace your transcript edits?",
      message:
        "Re-transcribe replaces the hand-edited transcripts on host, guest.",
      actionLabel: "Replace transcripts",
    });
  });

  it("returns null when kept", async () => {
    answerQuestions(null);
    await expect(
      confirmReplaceEdited(["host"], "Re-transcribe"),
    ).resolves.toBeNull();
  });
});
