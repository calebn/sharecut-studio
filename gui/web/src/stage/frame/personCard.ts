import { rosterDisplayName } from "../../presence/colors";
import {
  type FollowUiCaps,
  isObservingClient,
  remotePlayheadSec,
} from "../../presence/followSync";
import { planGoTo } from "../../presence/goToPlan";
import { clientStage, presenceStage } from "../../presence/presenceStage";
import { stageLabel } from "../../system/verbs";
import type { SessionClient } from "../../types/session";
import type { StageId } from "../../types/stage";
import { capitalize } from "../../utils/format";
import { formatTimeShort } from "../../utils/time";

export type PresenceViewer = {
  stage: StageId;
  caps: FollowUiCaps;
  durationSec: number;
};

export type PersonCard = {
  id: string;
  name: string;
  colorIndex: number;
  agent: boolean;
  roleLabel: string;
  parts: readonly string[];
  badge: StageId | null;
  goTo: boolean;
  following: boolean;
};

export function personCard(
  client: SessionClient,
  names: ReadonlyMap<string, string>,
  viewer: PresenceViewer | undefined,
  followingClientId: string | null,
): PersonCard {
  const name = names.get(client.client_id) ?? rosterDisplayName(client);
  const stage = clientStage(client);
  const leaderId = client.meta?.following;
  const duration = viewer?.durationSec ?? Number.NaN;
  const sec = isObservingClient(client)
    ? null
    : remotePlayheadSec(client, duration);
  const parts = [
    stage ? stageLabel(stage) : null,
    leaderId
      ? `Following ${names.get(leaderId) ?? leaderId}`
      : sec === null
        ? null
        : formatTimeShort(sec),
  ].filter((part): part is string => part !== null);
  const plan = viewer
    ? planGoTo(client, viewer.caps, duration, viewer.stage)
    : null;
  return {
    id: client.client_id,
    name,
    colorIndex: client.meta?.color_index ?? 0,
    agent: client.role === "agent",
    roleLabel: capitalize(client.role),
    parts,
    badge: viewer ? presenceStage(client, viewer.stage) : null,
    goTo: Boolean(plan?.moves),
    following: followingClientId === client.client_id,
  };
}

export function cardLabel(card: PersonCard): string {
  return [card.name, ...card.parts].join(", ");
}

export function cardWhere(card: PersonCard): string {
  return [card.roleLabel, ...card.parts].join(" · ");
}
