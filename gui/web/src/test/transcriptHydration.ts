import { vi } from "vitest";
import { loadDocumentState } from "../api/project";
import { documentAuthority } from "../document/authorityState";
import type { DocumentSnapshot } from "../document/projectPatch";
import type { CombinedUtterance, ProjectView } from "../types/project";

export const HYDRATION_TOKEN = "b".repeat(64);

export function withoutWords(project: ProjectView): ProjectView {
  return {
    ...project,
    transcript: project.transcript ?? { utterances: [] },
    meta: {
      ...project.meta,
      hydration: { transcript_words: false, history_groups: true },
    },
  };
}

export function withWords(shell: ProjectView): ProjectView {
  const utterance = {
    track_id: "host",
    speaker: "A",
    start: 0,
    end: 1,
    text: "Um.",
    words: [{ text: "Um.", start: 0, end: 1, word_index: 0 }],
  } as unknown as CombinedUtterance;
  return {
    ...shell,
    transcript: { utterances: [utterance] },
    meta: {
      ...shell.meta,
      hydration: { transcript_words: true, history_groups: true },
    },
  };
}

export function shellSnapshot(
  project: ProjectView,
  seq: number,
): DocumentSnapshot {
  return {
    server_seq: seq,
    state_token: HYDRATION_TOKEN,
    file: { mtime_ns: seq, size: 1 },
    project,
  };
}

export function interceptDetailLoads(): {
  land: (detail: ProjectView) => Promise<void>;
} {
  const waiting: Array<(snapshot: DocumentSnapshot) => void> = [];
  vi.mocked(loadDocumentState).mockImplementation(
    () =>
      new Promise((resolve) => {
        waiting.push(resolve);
      }),
  );
  return {
    land: async (detail) => {
      const resolve = waiting.at(-1);
      if (!resolve) throw new Error("no detail load in flight");
      resolve({
        server_seq: documentAuthority.seq,
        state_token: documentAuthority.token ?? undefined,
        project: detail,
      });
      await vi.waitFor(() => {
        if (
          documentAuthority.project?.meta.hydration?.transcript_words !== true
        )
          throw new Error("hydration not applied");
      });
    },
  };
}
