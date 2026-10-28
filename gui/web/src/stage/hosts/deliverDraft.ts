import { useSyncExternalStore } from "react";
import type { Chapter, Clip } from "../../stages/deliver/deliverLogic";

export type DeliverPage = { key: string; chapters: Chapter[]; clips: Clip[] };

type DeliverDraft = {
  page: DeliverPage | null;
  epoch: number;
  pending: number;
  unsaved: boolean;
  ackedAt: number;
  since: number;
};

type Entry = { draft: DeliverDraft; queue: Promise<unknown> };

const EMPTY: DeliverDraft = {
  page: null,
  epoch: 0,
  pending: 0,
  unsaved: false,
  ackedAt: 0,
  since: 0,
};

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

function entryFor(path: string): Entry {
  let entry = entries.get(path);
  if (!entry) {
    entry = {
      draft: { ...EMPTY, since: Date.now() },
      queue: Promise.resolve(),
    };
    entries.set(path, entry);
  }
  return entry;
}

function update(
  entry: Entry,
  change: (draft: DeliverDraft) => Partial<DeliverDraft>,
) {
  entry.draft = { ...entry.draft, ...change(entry.draft) };
  for (const listener of [...listeners]) listener();
}

export function patchDeliverDraft(
  path: string,
  change: (draft: DeliverDraft) => Partial<DeliverDraft>,
) {
  update(entryFor(path), change);
}

export function sendDeliverEdit(
  path: string,
  work: (path: string) => Promise<void>,
) {
  const entry = entryFor(path);
  update(entry, (d) => ({ pending: d.pending + 1 }));
  entry.queue = entry.queue
    .then(() => work(path))
    .catch(() => update(entry, () => ({ unsaved: true })))
    .finally(() =>
      update(entry, (d) => ({ pending: Math.max(0, d.pending - 1) })),
    );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDeliverDraft(path: string | null): DeliverDraft {
  return useSyncExternalStore(subscribe, () =>
    path ? (entries.get(path)?.draft ?? EMPTY) : EMPTY,
  );
}
