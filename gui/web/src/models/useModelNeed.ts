import { useEffect } from "react";
import { runPointerCommand } from "../commands/pointer";
import { askConfirm } from "../feedback/ask";
import { canManageProjects } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { type ModelActivity, modelActivity } from "./activity";
import {
  capabilityOf,
  type NeedTarget,
  plainSize,
  rowInstalled,
} from "./capability";
import type {
  ModelNeedPlacement,
  ModelNeedRowProps,
  ModelNeedRowViewProps,
} from "./ModelNeedRow";
import type { ModelState } from "./types";
import { useModels } from "./useModels";

async function removeWithConfirm(
  model: NeedTarget,
  remove: ReturnType<typeof useModels>["remove"],
): Promise<void> {
  const { name } = capabilityOf(model.id, model.label);
  const size = plainSize(model.size);
  const sure = await askConfirm({
    title: `Remove ${name}?`,
    message: `This frees about ${size}. Get downloads it again.`,
    keepLabel: "Keep it",
    actionLabel: "Remove",
    danger: false,
  });
  if (!sure) {
    return;
  }
  const outcome = await remove(model.id, model.variant);
  const { announceStatus } = useDawStore.getState();
  if (outcome.kind === "ok") {
    announceStatus(`${name} removed.`);
  } else if (outcome.kind === "busy") {
    announceStatus(`${name} stays: a download or job is running.`, {
      tone: "error",
    });
  } else {
    announceStatus(`Couldn't remove ${name}. ${outcome.plain}`, {
      tone: "error",
    });
  }
}

/**
 * The live state of one model need: its row, the download and check
 * callbacks, and the Manage link. Null once the need is met, in a need row.
 */
export function useModelNeed(
  model: NeedTarget,
  placement: ModelNeedPlacement = "need",
  { onGet, onManage }: Pick<ModelNeedRowProps, "onGet" | "onManage"> = {},
): Omit<ModelNeedRowViewProps, "placement" | "children"> | null {
  const { models, lookup, observe, busy, download, cancel, remove } =
    useModels();
  const { id, variant } = model;
  const { row, observation } = lookup(model);
  const loaded = models !== null;
  useEffect(() => {
    if (placement === "need" && loaded && observation.generation === 0) {
      void observe({ id, variant });
    }
  }, [id, variant, placement, loaded, observation.generation, observe]);
  const mayManage = useDawStore((s) => canManageProjects(s.projectPath));
  const manage =
    placement === "need" && mayManage
      ? (onManage ?? (() => runPointerCommand("models.open")))
      : undefined;
  const sizeAsked = model.id === "whisper" && model.variant;
  const activity: ModelActivity = modelActivity(row, busy);
  if (placement === "need" && rowInstalled(row, model)) {
    return null;
  }
  const state: ModelState = row?.state ?? {
    kind: observation.kind === "checking" ? "checking" : "unavailable",
  };
  return {
    model,
    state,
    blockedReason: activity.blockedReason,
    onGet: () => {
      const outcome = download(
        [model.id],
        sizeAsked ? { whisperModel: model.variant ?? undefined } : undefined,
      );
      onGet?.(outcome);
    },
    onCancel: () => void cancel(),
    onCheck: () => void observe(model),
    onManage: manage,
    onRemove:
      placement === "list"
        ? () => void removeWithConfirm(model, remove)
        : undefined,
  };
}
