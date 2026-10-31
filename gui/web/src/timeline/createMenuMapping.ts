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
 * Rows of the host's own. The leaf's `CreateRowId` lists the rows it knows,
 * and Record here (#2609, host only) is not one of them. The leaf draws rows
 * from data and hands the picked id back unread, so the host adds this one and
 * takes the id back as its own.
 */
export type HostRowId = CreateRowId | "recordHere";

const RECORD_ROW = {
  id: "recordHere",
  label: "Record here",
  icon: "mic",
  keys: [],
} as unknown as CreateRow;

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
  recordHere: "record.here",
} as const satisfies Record<HostRowId, string>;

/** What a row's command is called with at the held `place`. */
export function createPickArgs(
  id: HostRowId,
  place: Pick<CreateMenuPlace, "atTime" | "trackId">,
): Record<string, unknown> {
  const { atTime, trackId } = place;
  switch (id) {
    case "split":
    case "addChapter":
    case "paste":
    case "recordHere":
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
  return (
    createMenuRows({
      lane: onLane,
      envelopeShown: onLane,
      clipboardHasAudio: getClipboard() != null,
    })
      // Record here sits with the point's verbs, above the lane's group.
      .flatMap((row) => (row.id === "addChapter" ? [row, RECORD_ROW] : [row]))
      .filter(
        (row) =>
          evaluateWhen(COMMANDS[CREATE_MENU_COMMANDS[row.id]].when, ctx).ok,
      )
      // The leaf takes Split's chord from the verb table, but the chord runs
      // edit.split at the playhead while the row cuts at the held time, and the
      // keymap is held while the menu is open: the cap would name a key that
      // does something else.
      .map((row) => (row.id === "split" ? { ...row, keys: [] } : row))
  );
}

/** "Create at 00:12.400 on Maya, 4 actions", for the live region. */
export function createAnnouncement(
  time: string,
  track: string | null,
  actions: number,
): string {
  return `Create at ${time}${track ? ` on ${track}` : ""}, ${actions} ${
    actions === 1 ? "action" : "actions"
  }`;
}

/**
 * Runs the picked row's command at the held place. The gate is checked again
 * here, since the session can change while the menu is open (a share link
 * loses edit rights); a shut gate tells its reason and runs nothing. The volume
 * layer is turned on first when it is hidden, and stays on if the command then
 * refuses. A refusal is told, since the menu is gone by then.
 */
export async function runCreatePick(
  id: HostRowId,
  place: Pick<CreateMenuPlace, "atTime" | "trackId">,
): Promise<void> {
  const store = useDawStore.getState();
  const command = CREATE_MENU_COMMANDS[id];
  const gate = evaluateWhen(COMMANDS[command].when, buildCommandContext());
  if (!gate.ok) {
    store.announceStatus(gate.reason, { tone: "error" });
    return;
  }
  const toldBefore = store.statusAnnouncementSeq;
  if (id === "addVolumePoint" && !store.layers.showLevels) {
    store.setLayerVisible("showLevels", true);
  }
  try {
    const result = await executePointerCommand(
      command,
      createPickArgs(id, place),
    );
    // A command that told its own refusal (a failed paste or envelope save
    // does) has already toasted, in words that carry the reason. The same
    // words told twice in a row are absorbed by the toast, which leaves the
    // sequence where it was, so the standing text is checked as well; a second
    // toast with other words would flip it.
    const live = useDawStore.getState();
    const told =
      live.statusAnnouncementSeq !== toldBefore ||
      live.statusAnnouncement.includes(
        result.status === "disabled" ? result.reason : "",
      );
    if (result.status === "disabled" && !told) {
      live.announceStatus(result.reason, { tone: "error" });
    }
  } catch (error) {
    useDawStore
      .getState()
      .announceStatus(errorMessage(error), { tone: "error" });
  }
}
