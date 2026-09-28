import { useBootstrapDownload } from "../hooks/useBootstrapDownload";
import type { PipelineComponentStatus } from "../types/pipeline";
import { Button, InlineError } from "../ui";

export const WORD_ALIGNER_COMPONENT = "word-aligner";

function readinessMessage(
  status: PipelineComponentStatus | undefined,
  size: string,
): string {
  if (status?.ok === true) {
    return `Word aligner is downloaded (${size}).`;
  }
  if (status?.pin_mismatch === true) {
    return `Word aligner does not match its pinned download (${size}). Download it again; words keep Whisper's times until then.`;
  }
  return `Word aligner needs download (${size}). Words keep Whisper's times until it is downloaded.`;
}

/**
 * Readiness + download / Re-time words for "Precise word boundaries" (shown
 * only while the flag is on).
 */
export function WordAlignerStatus({
  status,
  disabled,
  retiming,
  onDownloaded,
  onRetime,
}: {
  status: PipelineComponentStatus | undefined;
  disabled: boolean;
  /** True while a Re-time words request is starting (busy label + aria-busy, like the download). */
  retiming: boolean;
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
        {readinessMessage(status, size)}
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
          <Button
            disabled={disabled}
            aria-busy={retiming || undefined}
            onClick={onRetime}
          >
            {retiming ? "Re-timing…" : "Re-time words"}
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
