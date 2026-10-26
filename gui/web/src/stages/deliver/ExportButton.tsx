import { SystemIcon } from "../../system/SystemIcon";
import { hintOf, iconOf, verbOf } from "../../system/verbDisplay";
import { Button } from "../../ui";
import type { primaryAction } from "./deliverLogic";

type Props = {
  action: ReturnType<typeof primaryAction>;
  /** Why Export cannot start. */
  blocker?: string;
  onExport: () => void;
  onReveal: () => void;
  onDownload: () => void;
};

/** The only filled button on the page. Reveal or Download takes its place after an export. */
export function ExportButton({
  action,
  blocker,
  onExport,
  onReveal,
  onDownload,
}: Props) {
  const verb = verbOf("export");
  return (
    <div className="dv-primary">
      {action === "reveal" ? (
        <Button variant="primary" className="dv-export" onClick={onReveal}>
          <SystemIcon name="folder-open" size={18} />
          Reveal in Finder
        </Button>
      ) : action === "download" ? (
        <Button variant="primary" className="dv-export" onClick={onDownload}>
          <SystemIcon name="download" size={18} />
          Download all
        </Button>
      ) : (
        <Button
          variant="primary"
          className="dv-export"
          disabledReason={action === "exporting" ? "Exporting now." : blocker}
          title={`${verb.label}${hintOf(verb)}`}
          onClick={onExport}
        >
          <SystemIcon name={iconOf("export")} size={18} />
          {verb.label}
        </Button>
      )}
    </div>
  );
}
