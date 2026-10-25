import { describe, expect, it } from "vitest";
import {
  EPISODE_DURATION_SEC,
  emptyEpisode,
  episode,
  MIRA,
  selections,
  TOMAS,
} from "./episodeFixture";

describe("episode fixture", () => {
  it("has two speakers and 40 aligned turns that cover the timeline", () => {
    const { transcript, tracks } = episode();
    const utterances = transcript?.utterances ?? [];
    expect(tracks.map((track) => track.id)).toEqual([MIRA, TOMAS]);
    expect(utterances).toHaveLength(40);
    expect(new Set(utterances.map((u) => u.speaker))).toEqual(
      new Set(["Mira", "Tomas"]),
    );
    expect(utterances.at(-1)?.timeline_end).toBeLessThanOrEqual(
      EPISODE_DURATION_SEC,
    );
  });

  it("numbers words per track without gaps", () => {
    const utterances = episode().transcript?.utterances ?? [];
    for (const trackId of [MIRA, TOMAS]) {
      const indices = utterances
        .filter((u) => u.track_id === trackId)
        .flatMap((u) => (u.words ?? []).map((w) => w.word_index));
      expect(indices).toEqual(indices.map((_, i) => i));
    }
  });

  it("carries one pending edit, one applied edit, comments, chapters and a social clip", () => {
    const project = episode();
    expect(project.pending_edits.map((e) => e.id)).toEqual(["pending-1"]);
    expect(project.applied_edits.records.map((e) => e.id)).toEqual([
      "applied-1",
    ]);
    expect(project.comments.map((c) => c.id)).toEqual([
      "comment-1",
      "comment-2",
      "comment-3",
    ]);
    expect(project.chapters.map((c) => c.title)).toEqual([
      "Cold open",
      "The harbor depot",
      "Protect your morning",
    ]);
    expect(project.social_clips.map((c) => c.id)).toEqual(["social-1"]);
  });

  it("selections name ids that exist in the episode", () => {
    const project = episode();
    expect(selections.pendingEdit.id).toBe(project.pending_edits[0]?.id);
    expect(selections.comment.id).toBe(project.comments[0]?.id);
    expect(selections.clip.id).toBe(project.clips.tracks[MIRA]?.[0]?.id);
  });

  it("emptyEpisode drops everything reviewable", () => {
    const project = emptyEpisode();
    expect(project.pending_edits).toEqual([]);
    expect(project.comments).toEqual([]);
    expect(project.history.groups).toEqual([]);
    expect(project.transcript?.utterances).toHaveLength(40);
  });
});
