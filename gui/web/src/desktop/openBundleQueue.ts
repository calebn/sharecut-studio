export const OPEN_BUNDLE_EVENT = "sharecut:open-bundle";
export const OPEN_BUNDLE_QUEUE_KEY = "__sharecutOpenBundleQueue";

/** A file the native app copied into its inbox: the host's id, its sanitised name, its byte size. */
export type OpenBundleItem = { id: string; name: string; size: number };

type QueueWindow = Window & { [OPEN_BUNDLE_QUEUE_KEY]?: unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const taken = new Set<string>();

function asItem(value: unknown): OpenBundleItem | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, name, size } = value as Record<string, unknown>;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (typeof name !== "string" || name.trim() === "") return null;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0)
    return null;
  return { id: id.toLowerCase(), name, size };
}

/** Items the native host pushed that this page has not taken yet, oldest first, each id once. */
export function drainOpenBundleQueue(): OpenBundleItem[] {
  const queue = (window as QueueWindow)[OPEN_BUNDLE_QUEUE_KEY];
  if (!Array.isArray(queue)) return [];
  const items: OpenBundleItem[] = [];
  for (const raw of queue.splice(0, queue.length)) {
    const item = asItem(raw);
    if (!item || taken.has(item.id)) continue;
    taken.add(item.id);
    items.push(item);
  }
  return items;
}

export function _resetOpenBundleQueueForTests(): void {
  taken.clear();
  delete (window as QueueWindow)[OPEN_BUNDLE_QUEUE_KEY];
}
