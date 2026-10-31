import { formatBytes } from "../../models";
import { SystemIcon } from "../../system/SystemIcon";
import { Button } from "../../ui";
import {
  type ExportedFile,
  type FileAccess,
  groupByKind,
  hasLargeFile,
} from "./exportedFileModel";

type Props = {
  files: readonly ExportedFile[];
  access: FileAccess;
  running?: boolean;
  grouped?: boolean;
  onReveal?: (file: ExportedFile) => void;
  onStarted?: (file: ExportedFile) => void;
};

const RUNNING_REASON = "Exporting now. Download when it finishes.";

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1);
}

function Row({
  file,
  access,
  running,
  onReveal,
  onStarted,
}: Omit<Props, "files" | "grouped"> & { file: ExportedFile }) {
  const verb = access === "reveal" ? "Reveal" : "Download";
  const name = `${verb} ${file.name}, ${formatBytes(file.bytes)}`;
  const icon = (
    <SystemIcon
      name={access === "reveal" ? "folder-open" : "download"}
      size={16}
    />
  );
  return (
    <li className="dv-file-row" data-kind={file.kind}>
      <span className="dv-file-tile sys-mono" aria-hidden="true">
        {extOf(file.name)}
      </span>
      <span className="dv-file-text">
        <span className="dv-file-name sys-mono">{file.name}</span>
        <span className="dv-file-meta">
          {file.label}
          <span className="sys-mono dv-file-bytes">
            {formatBytes(file.bytes)}
          </span>
          {file.current ? null : (
            <span className="dv-file-stale">Edited since export</span>
          )}
        </span>
      </span>
      {access === "download" && file.href && !running ? (
        <a
          className="ui-control modifier-action dv-file-action"
          href={file.href}
          download={file.name}
          aria-label={name}
          onClick={() => onStarted?.(file)}
        >
          {icon}
          <span className="dv-file-verb">{verb}</span>
        </a>
      ) : (
        <Button
          className="dv-file-action"
          aria-label={name}
          disabledReason={running ? RUNNING_REASON : undefined}
          onClick={() => onReveal?.(file)}
        >
          {icon}
          <span className="dv-file-verb">{verb}</span>
        </Button>
      )}
    </li>
  );
}

export function ExportedFiles({
  files,
  access,
  running = false,
  grouped = false,
  onReveal,
  onStarted,
}: Props) {
  if (files.length === 0) return null;
  const rows = (list: readonly ExportedFile[]) => (
    <ul className="dv-files">
      {list.map((file) => (
        <Row
          key={file.id}
          file={file}
          access={access}
          running={running}
          onReveal={onReveal}
          onStarted={onStarted}
        />
      ))}
    </ul>
  );
  return (
    <div className="dv-exported">
      {grouped
        ? groupByKind(files).map((group) => (
            <div key={group.kind} className="dv-file-group">
              <h3 className="dv-file-group-title">{group.title}</h3>
              {rows(group.files)}
            </div>
          ))
        : rows(files)}
      {access === "download" && hasLargeFile(files) ? (
        <p className="dv-note">
          The master is large. Use Wi-Fi, or choose the listening file.
        </p>
      ) : null}
      {running ? <p className="dv-note">{RUNNING_REASON}</p> : null}
    </div>
  );
}
