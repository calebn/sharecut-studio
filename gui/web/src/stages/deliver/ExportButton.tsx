import { SystemIcon } from "../../system/SystemIcon";
import { hintOf, iconOf, verbOf } from "../../system/verbDisplay";
import { Button } from "../../ui";
import { useDisabledReasonNote } from "../../ui/disabledReason";

type Props = {
  exporting: boolean;
  blocker?: string;
  onExport: () => void;
};

export function ExportButton({ exporting, blocker, onExport }: Props) {
  const verb = verbOf("export");
  const reason = useDisabledReasonNote(exporting ? undefined : blocker);
  return (
    <div className="dv-primary">
      <Button
        variant="primary"
        className="dv-export"
        disabledReason={exporting ? "Exporting now." : blocker}
        {...reason.describedBy}
        title={`${verb.label}${hintOf(verb)}`}
        onClick={onExport}
      >
        <SystemIcon name={iconOf("export")} size={18} />
        {verb.label}
      </Button>
      {reason.note}
    </div>
  );
}
