import { useState } from "react";
import type { PrepareSession, SourceActions } from "./prepareTypes";

/**
 * Story-only state for the Source cards: names, voice counts, playing and
 * order change in place, and each change is also passed on to `spy`. The real
 * stage keeps this in the project.
 */
export function useDemoSessions(
  initial: readonly PrepareSession[],
  spy: SourceActions,
): { sessions: readonly PrepareSession[]; actions: SourceActions } {
  const [sessions, setSessions] = useState(initial);
  const change = (
    id: string,
    update: (
      source: PrepareSession["sources"][number],
    ) => PrepareSession["sources"][number],
  ) =>
    setSessions((all) =>
      all.map((one) => ({
        ...one,
        sources: one.sources.map((source) =>
          source.id === id ? update(source) : source,
        ),
      })),
    );
  const actions: SourceActions = {
    ...spy,
    onName: (id, name) => {
      change(id, (source) => ({
        ...source,
        name,
        state:
          name.trim() && source.state === "needs-name" ? "ready" : source.state,
      }));
      spy.onName(id, name);
    },
    onVoices: (id, voices) => {
      change(id, (source) => ({ ...source, voices }));
      spy.onVoices(id, voices);
    },
    onHear: (id) => {
      change(id, (source) => ({ ...source, playing: !source.playing }));
      spy.onHear(id);
    },
    onMove: (id, direction) => {
      setSessions((all) =>
        all.map((one) => {
          const at = one.sources.findIndex((source) => source.id === id);
          const to = direction === "up" ? at - 1 : at + 1;
          if (at < 0 || to < 0 || to >= one.sources.length) return one;
          const next = [...one.sources];
          [next[at], next[to]] = [next[to], next[at]];
          return { ...one, sources: next };
        }),
      );
      spy.onMove(id, direction);
    },
  };
  return { sessions, actions };
}
