import { createContext, useContext } from "react";
import type { ModelGate } from "../../models";
import type { ExportRequest } from "../../stages/deliver/deliverLogic";
import type { PipelineJobSnapshot } from "../../types/pipeline";
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
      paths: string[];
      measured: string | null;
      finishedAt: number;
    }
  | { kind: "failed"; reason: string }
  | { kind: "cancelled"; paths: string[] };

export type ExportFlow = {
  run: ExportRun;
  job: PipelineJobSnapshot | null;
  settings: ExportSettings | null;
  settingsError: string | null;
  loading: boolean;
  loadedGeneration: number;
  selected: readonly string[];
  setSelected: (keys: readonly string[]) => void;
  gate: ModelGate;
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
