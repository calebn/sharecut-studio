import type { ReactNode } from "react";
import { TrackMix } from "../../tracks/TrackMix";
import type { StageSheet } from "../../types/stage";
import { ToolsSheet } from "./ToolsSheet";

/** The frame's `sheets` for the Edit stage: on a phone, the mixer and the tools. */
export const EDIT_SHEETS: Partial<Record<StageSheet, ReactNode>> = {
  mix: <TrackMix />,
  tools: <ToolsSheet />,
};
