import { Button } from "../ui";
import { CHECK_MIC_COPY, MIC_CHECK_FAILED_COPY, NO_AUDIO_COPY } from "./types";

export function NoAudioNotice({
  onCheck,
  checkFailed = false,
}: {
  onCheck?: () => void;
  checkFailed?: boolean;
}) {
  return (
    <div className="record-warn" role="alert">
      <span>{NO_AUDIO_COPY}</span>
      {checkFailed ? <span> {MIC_CHECK_FAILED_COPY}</span> : null}{" "}
      {onCheck ? (
        <Button type="button" onClick={onCheck}>
          {CHECK_MIC_COPY}
        </Button>
      ) : null}
    </div>
  );
}
