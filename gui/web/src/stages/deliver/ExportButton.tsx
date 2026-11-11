import { SystemIcon } from "../../system/SystemIcon";
import { hintOf, iconOf, verbOf } from "../../system/verbDisplay";
import { Button } from "../../ui";
import { useDisabledReasonNote } from "../../ui/disabledReason";
import type { AfterExport } from "./deliverFiles";

type Props = {
  exporting: boolean;
  blocker?: string;
  after?: AfterExport;
  onExport: () => void;
};

export function ExportButton({ exporting, blocker, after, onExport }: Props) {
  const verb = verbOf("export");
  const reason = useDisabledReasonNote(exporting ? undefined : blocker);
  return (
    <div className="dv-primary">
      {after ? <AfterExportPrimary {...after} busy={exporting} /> : null}
      <Button
        variant={after ? "default" : "primary"}
        className="dv-export"
        disabledReason={exporting ? "Exporting now." : blocker}
        {...reason.describedBy}
        title={`${verb.label}${hintOf(verb)}`}
        onClick={onExport}
      >
        <SystemIcon name={iconOf("export")} size={18} />
        {after ? `${verb.label} again` : verb.label}
      </Button>
      {reason.note}
    </div>
  );
}

function AfterExportPrimary({
  access,
  file,
  busy,
  onReveal,
  onStarted,
}: AfterExport & { busy: boolean }) {
  if (busy) {
    const download = access === "download" && file.href;
    return (
      <Button
        variant="primary"
        className="dv-export"
        disabledReason="Exporting now."
      >
        <SystemIcon name={download ? "download" : "folder-open"} size={18} />
        {download ? "Download" : "Reveal in folder"}
      </Button>
    );
  }
  if (access === "download" && file.href) {
    return (
      <a
        className="ui-control modifier-action primary dv-export"
        href={file.href}
        download={file.name}
        aria-label={`Download main file ${file.name}`}
        onClick={() => onStarted?.(file)}
      >
        <SystemIcon name="download" size={18} />
        Download
      </a>
    );
  }
  return (
    <Button
      variant="primary"
      className="dv-export"
      onClick={() => onReveal?.(file)}
    >
      <SystemIcon name="folder-open" size={18} />
      Reveal in folder
    </Button>
  );
}
