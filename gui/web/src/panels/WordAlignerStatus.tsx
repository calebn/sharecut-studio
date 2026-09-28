import { useBootstrapDownload } from "../hooks/useBootstrapDownload";
import type { PipelineComponentStatus } from "../types/pipeline";
import { Button, InlineError } from "../ui";

export const WORD_ALIGNER_COMPONENT = "word-aligner";

/**
 * Readiness + download / Re-time words for "Precise word boundaries" (shown
 * only while the flag is on).
 */
export function WordAlignerStatus({
  status,
  disabled,
  onDownloaded,
  onRetime,
}: {
  status: PipelineComponentStatus | undefined;
  disabled: boolean;
  onDownloaded: () => void;
  onRetime: () => void;
}) {
  const { busy, progress, error, download, reset } = useBootstrapDownload();
  const size = status?.size ?? "~360 MB";
  const ok = status?.ok === true;

  const onDownload = async () => {
    if (await download({ components: [WORD_ALIGNER_COMPONENT] })) {
      reset();
      onDownloaded();
    }
  };

  return (
    <div className="pipeline-aligner">
      <span className="pipeline-param-help" role="status">
        {ok
          ? `Word aligner is downloaded (${size}).`
          : `Word aligner needs download (${size}). Words keep Whisper's times until it is downloaded.`}
      </span>
      {busy && progress ? (
        <span
          className="pipeline-aligner-progress"
          role="status"
          aria-live="polite"
        >
          {progress}
        </span>
      ) : null}
      <InlineError message={error} />
      <div className="cluster">
        {ok ? (
          <Button disabled={disabled} onClick={onRetime}>
            Re-time words
          </Button>
        ) : (
          <Button
            disabled={disabled || busy}
            aria-busy={busy || undefined}
            onClick={() => void onDownload()}
          >
            {busy ? "Downloading…" : "Download word aligner"}
          </Button>
        )}
      </div>
    </div>
  );
}
