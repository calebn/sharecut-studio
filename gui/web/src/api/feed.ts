import { isShareProjectKey } from "../shareMode";
import { DocumentCommand } from "../types/documentCommands.generated";
import type { FeedEdit, PinAuthor, Served } from "../types/feedView";
import { submitDocumentCommand } from "./documentEdits";
import { apiFetch, HOST_KEY } from "./http";

const JSON_HEADERS = { "Content-Type": "application/json" };

/** A share key reaches the listing through the review routes; a project path through the host's. */
function keyOf(projectPath: string): string {
  return isShareProjectKey(projectPath) ? projectPath : HOST_KEY;
}

async function served(res: Response): Promise<Served> {
  return (await res.json()) as Served;
}

function post(body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
    signal,
  };
}

export async function loadFeed(
  projectPath: string,
  signal?: AbortSignal,
): Promise<Served> {
  return served(
    await apiFetch(
      keyOf(projectPath),
      {
        host: `/api/feed?path=${encodeURIComponent(projectPath)}`,
        guest: "/feed",
      },
      { signal },
    ),
  );
}

/**
 * Pin or unpin one value. The host edits through the feed route, as `by` when an undo restores
 * another author's value. A guest's episode values are document commands, so they undo like any
 * edit; its show values go through the feed route. A guest command that the queue holds for
 * later has not landed, so the answer is null and the caller keeps its preview.
 */
export async function sendFeedEdit(
  projectPath: string,
  edit: FeedEdit,
  by: PinAuthor = "person",
): Promise<Served | null> {
  if (!isShareProjectKey(projectPath))
    return served(
      await apiFetch(
        HOST_KEY,
        { host: "/api/feed/edit" },
        post({ path: projectPath, edit, by }),
      ),
    );
  if (!edit.key.startsWith("item."))
    return served(
      await apiFetch(projectPath, { guest: "/feed/edit" }, post({ edit })),
    );
  const reply =
    edit.op === "set"
      ? await submitDocumentCommand(projectPath, DocumentCommand.SetFeedField, {
          key: edit.key,
          value: edit.value,
        })
      : await submitDocumentCommand(
          projectPath,
          DocumentCommand.ClearFeedField,
          { key: edit.key },
        );
  return reply.queued === true ? null : loadFeed(projectPath);
}

export async function sendFeedWrite(projectPath: string): Promise<Served> {
  return served(
    await apiFetch(
      keyOf(projectPath),
      { host: "/api/feed/write", guest: "/feed/write" },
      post(isShareProjectKey(projectPath) ? {} : { path: projectPath }),
    ),
  );
}
