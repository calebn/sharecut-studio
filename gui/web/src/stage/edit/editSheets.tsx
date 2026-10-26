import type { ReactNode } from "react";
import { TrackMix } from "../../tracks/TrackMix";
import type { StageSheet } from "../../types/stage";
import { ViewSheet } from "./ViewSheet";

/** The frame's `sheets` for the Edit stage: the eye sheet and, on a phone, the mixer. */
export const EDIT_SHEETS: Partial<Record<StageSheet, ReactNode>> = {
  view: <ViewSheet />,
  mix: <TrackMix />,
};
