import { isShareProjectKey } from "../shareMode";
import { readApiFailure } from "../utils/apiError";
import { hostFetch } from "./documentTransport";

/** What Accept would refuse for one take: the server's code and sentence. */
export type SessionTakeRefusal = { code: string; message: string };

/** One take of a staged session, from `GET /api/session-suggestion/takes`. */
export type SessionTakeDetail = {
  take_index: number;
  duration_s: number;
  /** Null when nothing transcribed the take, which is not the same as zero words. */
  word_count: number | null;
  speech_text: string | null;
  chosen: boolean;
  default: boolean;
  acceptable: boolean;
  refusal: SessionTakeRefusal | null;
};

export type SessionTakes = {
  suggestion_id: string;
  kind: "insert" | "replace";
  selectable: boolean;
  selected_take: number | null;
  default_take: number | null;
  takes: SessionTakeDetail[];
};

/** Host only: the takes of a staged session with length, words and what Accept would refuse. */
export async function loadSessionTakes(
  projectPath: string,
  suggestionId: string,
  signal?: AbortSignal,
): Promise<SessionTakes> {
  if (isShareProjectKey(projectPath))
    throw new Error("Takes are only available to the host.");
  const params = new URLSearchParams({
    path: projectPath,
    suggestion_id: suggestionId,
  });
  const response = await hostFetch(`/api/session-suggestion/takes?${params}`, {
    signal,
  });
  if (!response.ok) throw await readApiFailure(response);
  return (await response.json()) as SessionTakes;
}
