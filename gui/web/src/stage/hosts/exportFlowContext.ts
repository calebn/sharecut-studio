import { createContext, useContext } from "react";
import type { ModelGate } from "../../models";
import type { ExportRequest } from "../../stages/deliver/deliverLogic";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import type { ExportSettings } from "../dialogs/exportSettings";

/** The export's own progress; the live job snapshot comes from the store. */
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
      paths: string[];
      measured: string | null;
      lufs: number | null;
      truePeak: number | null;
      finishedAt: number;
    }
  | { kind: "failed"; reason: string }
  | { kind: "cancelled"; paths: string[] };

export type ExportFlow = {
  run: ExportRun;
  /** The live job while the run follows one. */
  job: PipelineJobSnapshot | null;
  /** Null while the Pipeline config loads, or when it failed to load. */
  settings: ExportSettings | null;
  settingsError: string | null;
  loading: boolean;
  /** File extensions to export, in the order chosen. */
  selected: readonly string[];
  setSelected: (keys: readonly string[]) => void;
  gate: ModelGate;
  /** What the last export was asked to write. */
  request: ExportRequest | null;
  /** Starts an export with `keys` as the selected formats. Ignored while one runs. */
  start: (keys: readonly string[], request: ExportRequest) => void;
  cancel: () => void;
  /** Back to idle after a failure or cancel; a settings error is tried again. */
  again: () => void;
  /** Loads the Pipeline config again; the run in progress is untouched. */
  reload: () => void;
};

export const Flow = createContext<ExportFlow | null>(null);

export function useExportFlow(): ExportFlow {
  const flow = useContext(Flow);
  if (!flow) {
    throw new Error("useExportFlow needs an ExportFlowProvider above it.");
  }
  return flow;
}
