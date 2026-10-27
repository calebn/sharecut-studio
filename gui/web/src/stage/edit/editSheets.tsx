import type { ReactNode } from "react";
import { TrackMix } from "../../tracks/TrackMix";
import type { StageSheet } from "../../types/stage";
import { ToolsSheet } from "./ToolsSheet";
import { ViewSheet } from "./ViewSheet";

/** The frame's `sheets` for the Edit stage: the eye sheet and, on a phone, the mixer and the tools. */
export const EDIT_SHEETS: Partial<Record<StageSheet, ReactNode>> = {
  view: <ViewSheet />,
  mix: <TrackMix />,
  tools: <ToolsSheet />,
};
