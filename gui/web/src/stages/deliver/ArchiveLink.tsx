import { SystemIcon } from "../../system/SystemIcon";
import { Button } from "../../ui";
import {
  archiveLabel,
  type ExportArchive,
  RUNNING_REASON,
} from "./exportedFileModel";

type Props = {
  archive: ExportArchive;
  className: string;
  iconSize: number;
  running?: boolean;
  onStarted?: () => void;
};

export function ArchiveLink({
  archive,
  className,
  iconSize,
  running = false,
  onStarted,
}: Props) {
  if (running)
    return (
      <Button
        className={className}
        aria-label={archiveLabel(archive)}
        disabledReason={RUNNING_REASON}
      >
        <SystemIcon name="download" size={iconSize} />
        Download all
      </Button>
    );
  return (
    <a
      className={`ui-control modifier-action ${className}`}
      href={archive.href}
      download={archive.name}
      aria-label={archiveLabel(archive)}
      onClick={() => onStarted?.()}
    >
      <SystemIcon name="download" size={iconSize} />
      Download all
    </a>
  );
}
