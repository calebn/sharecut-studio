import { RecordAlert } from "./RecordAlert";
import { CHECK_MIC_COPY, MIC_CHECK_FAILED_COPY, NO_AUDIO_COPY } from "./types";

export function NoAudioNotice({
  onCheck,
  checkFailed = false,
}: {
  onCheck?: () => void;
  checkFailed?: boolean;
}) {
  return (
    <RecordAlert actionLabel={CHECK_MIC_COPY} onAction={onCheck}>
      <span>{NO_AUDIO_COPY}</span>
      {checkFailed ? <span> {MIC_CHECK_FAILED_COPY}</span> : null}
    </RecordAlert>
  );
}
