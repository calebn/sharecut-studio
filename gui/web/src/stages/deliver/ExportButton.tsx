import { SystemIcon } from "../../system/SystemIcon";
import { hintOf, iconOf, verbOf } from "../../system/verbDisplay";
import { Button } from "../../ui";
import { useDisabledReasonNote } from "../../ui/disabledReason";
import { ArchiveLink } from "./ArchiveLink";
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
      {after ? <AfterExportPrimary after={after} busy={exporting} /> : null}
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
  after,
  busy,
}: {
  after: AfterExport;
  busy: boolean;
}) {
  switch (after.kind) {
    case "archive":
      return busy ? (
        <Button
          variant="primary"
          className="dv-export"
          disabledReason="Exporting now."
        >
          <SystemIcon name="download" size={18} />
          Download all
        </Button>
      ) : (
        <ArchiveLink
          archive={after.archive}
          className="primary dv-export"
          iconSize={18}
          onStarted={after.onStarted}
        />
      );
    case "reveal":
      return (
        <Button
          variant="primary"
          className="dv-export"
          disabledReason={busy ? "Exporting now." : undefined}
          onClick={() => after.onReveal?.(after.file)}
        >
          <SystemIcon name="folder-open" size={18} />
          Reveal in folder
        </Button>
      );
    default:
      return after satisfies never;
  }
}
