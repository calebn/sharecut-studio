import { useSyncExternalStore } from "react";
import type { Chapter, Clip } from "../../stages/deliver/deliverLogic";

export type DeliverPage = { key: string; chapters: Chapter[]; clips: Clip[] };

export type DeliverDraft = {
  page: DeliverPage | null;
  reseed: { epoch: number; clips: Clip[] };
  pending: number;
  unsaved: boolean;
};

const EMPTY: DeliverDraft = {
  page: null,
  reseed: { epoch: 0, clips: [] },
  pending: 0,
  unsaved: false,
};

let slot = {
  path: "",
  draft: EMPTY,
  queue: Promise.resolve() as Promise<unknown>,
};
const listeners = new Set<() => void>();

function emit() {
  for (const listener of [...listeners]) listener();
}

export function patchDeliverDraft(
  path: string,
  change: (draft: DeliverDraft) => Partial<DeliverDraft>,
  adopt = true,
) {
  if (slot.path !== path) {
    if (!adopt) return;
    slot = { path, draft: EMPTY, queue: Promise.resolve() };
  }
  slot = { ...slot, draft: { ...slot.draft, ...change(slot.draft) } };
  emit();
}

export function sendDeliverEdit(
  path: string,
  work: (path: string) => Promise<void>,
) {
  patchDeliverDraft(path, (d) => ({ pending: d.pending + 1 }));
  slot.queue = slot.queue
    .then(() => work(path))
    .catch(() => patchDeliverDraft(path, () => ({ unsaved: true }), false))
    .finally(() =>
      patchDeliverDraft(path, (d) => ({ pending: d.pending - 1 }), false),
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
    slot.path === path ? slot.draft : EMPTY,
  );
}
