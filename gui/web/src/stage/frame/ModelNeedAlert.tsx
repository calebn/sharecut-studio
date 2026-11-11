import { type NeedTarget, needRowProps, useModelNeed } from "../../models";
import { FRAME_ALERT_PRIORITY, useFrameAlert } from "./useFrameAlert";

/** A model the stopped run needs, in the frame's alert slot: Get, progress, or Try again. */
export function ModelNeedAlert({ model }: { model: NeedTarget }) {
  const view = useModelNeed(model);
  const row = view ? needRowProps(view) : null;
  useFrameAlert(
    row?.state === "failed"
      ? FRAME_ALERT_PRIORITY.failed
      : FRAME_ALERT_PRIORITY.needsYou,
    row,
  );
  return null;
}
