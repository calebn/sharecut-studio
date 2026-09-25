import { useEffect, useMemo, useRef } from "react";
import { useDawStore } from "../state/dawStore";
import { mediaSignature } from "./mediaRef";
import { retainPcm } from "./pcmStore";
import { retainPyramids } from "./pyramidStore";
import { refreshWaveformStatus, retainWaveformStatus } from "./statusStore";

/**
 * Leaf that keeps waveform status in step with the project: a media change
 * (tracks' media, stem freshness, pinned sources) polls again at once, and
 * opening another project drops the old one's polls, fetches and data.
 */
export function WaveformStatusSync() {
  const projectPath = useDawStore((s) => s.projectPath);
  const project = useDawStore((s) => s.project);
  const signature = useMemo(() => mediaSignature(project), [project]);
  const lastSignature = useRef(signature);

  useEffect(() => {
    retainWaveformStatus(projectPath);
    retainPyramids(projectPath);
    retainPcm(projectPath);
  }, [projectPath]);

  useEffect(() => {
    if (lastSignature.current === signature) {
      return;
    }
    lastSignature.current = signature;
    refreshWaveformStatus(projectPath);
  }, [projectPath, signature]);

  return null;
}
