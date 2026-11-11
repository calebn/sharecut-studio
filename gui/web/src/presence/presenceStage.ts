import { STAGE_FOR_TAB } from "../state/stageRoutes";
import type { PresenceUi, SessionClient } from "../types/session";
import type { StageId } from "../types/stage";
import { KNOWN_TABS } from "./followSync";

export function clientStage(
  client: Pick<SessionClient, "meta">,
): StageId | null {
  const ui: PresenceUi | null | undefined = client.meta?.ui;
  const tab = ui?.tab;
  if (!tab || !KNOWN_TABS.has(tab)) return null;
  return STAGE_FOR_TAB[tab].stage;
}

export function presenceStage(
  client: Pick<SessionClient, "meta">,
  viewerStage: StageId,
): StageId | null {
  const stage = clientStage(client);
  return stage === viewerStage ? null : stage;
}
