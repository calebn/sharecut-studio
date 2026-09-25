import { MIC_LOST_COPY } from "./micPermission";
import { RecordAlert } from "./RecordAlert";
import { RECONNECT_MIC_COPY } from "./types";

export function MicLossNotice({ onRetry }: { onRetry?: () => void }) {
  return (
    <RecordAlert actionLabel={RECONNECT_MIC_COPY} onAction={onRetry}>
      <span>{MIC_LOST_COPY} Local recording is paused.</span>
    </RecordAlert>
  );
}
