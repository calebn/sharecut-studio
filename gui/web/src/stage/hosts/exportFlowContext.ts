import { createContext, useContext } from "react";
import type {
  ExportRequest,
  ExportSettingsStatus,
} from "../../stages/deliver/deliverLogic";
import type { LoudnessId, PipelineJobSnapshot } from "../../types/pipeline";
import type { ModelNeeded } from "../../utils/apiError";
import type { ExportReceipt } from "./exportReceipt";
import type { ExportSettings } from "./exportSettings";

export type ExportRun =
  | { kind: "idle" }
  | {
      kind: "running";
      jobId: string | null;
      cancelling: boolean;
      cancelError: string | null;
    }
  | {
      kind: "done";
      receipt: ExportReceipt;
      finishedAt: number;
    }
  | { kind: "failed"; reason: string }
  | { kind: "cancelled"; receipt: ExportReceipt | null; finishedAt: number };

export type ExportFlow = {
  run: ExportRun;
  job: PipelineJobSnapshot | null;
  settings: ExportSettings | null;
  settingsError: string | null;
  settingsStatus: ExportSettingsStatus;
  loading: boolean;
  loadedGeneration: number;
  selected: readonly string[];
  setSelected: (keys: readonly string[]) => void;
  loudness: LoudnessId | null;
  setLoudness: (choice: LoudnessId | null) => void;
  /** The model a start stopped on; the Deliver page shows its Get and the export resumes when it lands. */
  needs: ModelNeeded | null;
  request: ExportRequest | null;
  start: (keys: readonly string[], request: ExportRequest) => void;
  cancel: () => void;
  again: () => void;
  reload: () => number;
};

export const Flow = createContext<ExportFlow | null>(null);

export function useExportFlow(): ExportFlow {
  const flow = useContext(Flow);
  if (!flow) {
    throw new Error("useExportFlow needs an ExportFlowProvider above it.");
  }
  return flow;
}
