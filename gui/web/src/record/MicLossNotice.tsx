import { Button } from "../ui";
import { MIC_LOST_COPY } from "./micPermission";
import { RECONNECT_MIC_COPY } from "./types";

export function MicLossNotice({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="record-warn" role="alert">
      <span>{MIC_LOST_COPY} Local recording is paused.</span>{" "}
      {onRetry ? (
        <Button type="button" onClick={onRetry}>
          {RECONNECT_MIC_COPY}
        </Button>
      ) : null}
    </div>
  );
}
