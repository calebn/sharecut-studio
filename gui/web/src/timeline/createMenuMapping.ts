import { COMMANDS } from "../commands/catalog";
import { buildCommandContext, evaluateWhen } from "../commands/context";
import { executePointerCommand } from "../commands/pointer";
import { getClipboard } from "../edit/clipboard";
import {
  type CreateRow,
  type CreateRowId,
  createMenuRows,
} from "../stages/edit/createMenuRows";
import { useDawStore } from "../state/dawStore";
import { errorMessage } from "../utils/apiError";
import type { CreateMenuPlace } from "./touchGrammar";

/**
 * The command each Create menu row runs. A row whose command's gate is shut
 * is left out of the menu, because the leaf has no disabled rows and a pointer
 * dispatch skips the gate.
 */
export const CREATE_MENU_COMMANDS = {
  split: "edit.bladeCut",
  comment: "comment.draftAt",
  addChapter: "edit.addChapter",
  addVolumePoint: "envelope.addPoint",
  paste: "edit.paste",
} as const satisfies Record<CreateRowId, string>;

/** What a row's command is called with at the held `place`. */
export function createPickArgs(
  id: CreateRowId,
  place: Pick<CreateMenuPlace, "atTime" | "trackId">,
): Record<string, unknown> {
  const { atTime, trackId } = place;
  switch (id) {
    case "split":
    case "addChapter":
    case "paste":
      return { atTime };
    case "comment":
      return trackId ? { atTime, trackId } : { atTime };
    case "addVolumePoint":
      return { atTime, trackId };
  }
}

/**
 * The rows this place offers to this session: the leaf's rows for the held
 * point, less any whose command the session may not run. The volume row shows
 * on any lane, and picking it turns the envelope layer on.
 */
export function createMenuRowsFor(
  place: Pick<CreateMenuPlace, "trackId">,
): CreateRow[] {
  const onLane = place.trackId != null;
  const ctx = buildCommandContext();
  return createMenuRows({
    lane: onLane,
    envelopeShown: onLane,
    clipboardHasAudio: getClipboard() != null,
  }).filter(
    (row) => evaluateWhen(COMMANDS[CREATE_MENU_COMMANDS[row.id]].when, ctx).ok,
  );
}

/** "Create at 00:12.400 on Maya, 4 actions", for the live region. */
export function createAnnouncement(
  time: string,
  track: string | null,
  actions: number,
): string {
  return `Create at ${time}${track ? ` on ${track}` : ""}, ${actions} actions`;
}

/**
 * Runs the picked row's command at the held place. The volume layer is turned
 * on first when it is hidden, and stays on if the command then refuses. A
 * refusal is told, since the menu is gone by then.
 */
export async function runCreatePick(
  id: CreateRowId,
  place: Pick<CreateMenuPlace, "atTime" | "trackId">,
): Promise<void> {
  const store = useDawStore.getState();
  if (id === "addVolumePoint" && !store.layers.showLevels) {
    store.setLayerVisible("showLevels", true);
  }
  try {
    const result = await executePointerCommand(
      CREATE_MENU_COMMANDS[id],
      createPickArgs(id, place),
    );
    if (result.status === "disabled") {
      useDawStore.getState().announceStatus(result.reason, { tone: "error" });
    }
  } catch (error) {
    useDawStore
      .getState()
      .announceStatus(errorMessage(error), { tone: "error" });
  }
}
