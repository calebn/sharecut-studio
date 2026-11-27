import { isTauri } from "@tauri-apps/api/core";

export const OPEN_PROJECT_FILE_EVENT = "sharecut:open-project-file";
export const OPEN_PROJECT_QUEUE_KEY = "__sharecutOpenQueue";
export const OPEN_PROJECT_FRAGMENT_KEY = "open-project";

type QueueWindow = Window & { [OPEN_PROJECT_QUEUE_KEY]?: unknown };

let bootProjectFile: string | null = null;

/** Read and remove the cold-start fragment; call before the first render so no redirect drops it. */
export function captureBootProjectFile(): void {
  if (!isTauri()) return;
  const parts = window.location.hash.replace(/^#/, "").split("&");
  const prefix = `${OPEN_PROJECT_FRAGMENT_KEY}=`;
  const found = parts.find((part) => part.startsWith(prefix));
  if (found === undefined) return;
  const rest = parts.filter((part) => part !== found && part !== "");
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}${
      rest.length ? `#${rest.join("&")}` : ""
    }`,
  );
  try {
    const path = decodeURIComponent(found.slice(prefix.length)).trim();
    bootProjectFile = path || null;
  } catch {
    bootProjectFile = null;
  }
}

/** The cold-start project file, once. */
export function takeBootProjectFile(): string | null {
  const path = bootProjectFile;
  bootProjectFile = null;
  return path;
}

/** Paths the native host pushed before this page could listen, oldest first. */
export function drainOpenProjectQueue(): string[] {
  const holder = window as QueueWindow;
  const queue = holder[OPEN_PROJECT_QUEUE_KEY];
  if (!Array.isArray(queue)) return [];
  return queue
    .splice(0, queue.length)
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function _resetOpenProjectFileForTests(): void {
  bootProjectFile = null;
  delete (window as QueueWindow)[OPEN_PROJECT_QUEUE_KEY];
}
