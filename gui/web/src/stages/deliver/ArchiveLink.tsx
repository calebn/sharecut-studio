import { SystemIcon } from "../../system/SystemIcon";
import { archiveLabel, type ExportArchive } from "./exportedFileModel";

type Props = {
  archive: ExportArchive;
  className: string;
  iconSize: number;
  onStarted?: () => void;
};

export function ArchiveLink({
  archive,
  className,
  iconSize,
  onStarted,
}: Props) {
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
