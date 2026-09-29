import type { ReactNode } from "react";
import { useBootstrapDownload } from "../hooks/useBootstrapDownload";
import type {
  PipelineComponentStatus,
  PipelineForcedAlignment,
} from "../types/pipeline";
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
 * Readiness, the host's resolved Precise word boundaries state, and the download /
 * Re-time words action for that field. Re-time words needs the aligner downloaded and
 * the field on; otherwise the slot offers the download (#780).
 */
export function WordAlignerStatus({
  status,
  alignment,
  reasonId,
  disabled,
  retiming,
  onDownloaded,
  onRetime,
}: {
  status: PipelineComponentStatus | undefined;
  /** Resolved state from the config payload; omitted by callers that only know readiness. */
  alignment?: PipelineForcedAlignment;
  /** Id for the status text, so the Precise word boundaries checkbox can be described by it. */
  reasonId?: string;
  disabled: boolean;
  /** True while a Re-time words request is starting (busy label + aria-busy, like the download). */
  retiming: boolean;
  onDownloaded: () => void;
  onRetime: () => void;
}) {
  const { busy, progress, error, download, reset } = useBootstrapDownload();
  const size = status?.size ?? "~360 MB";
  const ok = status?.ok === true;
  const canRetime = ok && (alignment?.enabled ?? true);

  const onDownload = async () => {
    if (await download({ components: [WORD_ALIGNER_COMPONENT] })) {
      reset();
      onDownloaded();
    }
  };

  let action: ReactNode = null;
  if (!ok) {
    action = (
      <Button
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        onClick={() => void onDownload()}
      >
        {busy ? "Downloading…" : "Download word aligner"}
      </Button>
    );
  } else if (canRetime) {
    action = (
      <Button
        disabled={disabled}
        aria-busy={retiming || undefined}
        onClick={onRetime}
      >
        {retiming ? "Re-timing…" : "Re-time words"}
      </Button>
    );
  }

  return (
    <div className="pipeline-aligner">
      <span className="pipeline-param-help" role="status" id={reasonId}>
        {readinessMessage(status, size)}
        {alignment?.reason
          ? ` Precise word boundaries ${alignment.reason}.`
          : null}
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
      {action ? <div className="cluster">{action}</div> : null}
    </div>
  );
}
