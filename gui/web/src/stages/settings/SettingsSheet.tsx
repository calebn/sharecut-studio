import { useState } from "react";
import { Sheet } from "../../system/Sheet";
import { MenuRow } from "./MenuRow";

export type SettingsSheetProps = {
  form: "centered" | "bottom";
  open: boolean;
  onClose: () => void;
  /** Opens the Models sheet. */
  onModels: () => void;
  /** The folder the open episode is saved in; absent on Home, where no episode is open. */
  projectFolder?: string;
};

/**
 * Settings: the app's Models, and the open episode's own settings. Every other
 * setting lives where it is used (loudness in Deliver, vocabulary in Prepare).
 */
export function SettingsSheet({
  form,
  open,
  onClose,
  onModels,
  projectFolder,
}: SettingsSheetProps) {
  const [project, setProject] = useState(false);
  const pushed =
    project && projectFolder !== undefined
      ? {
          title: "Project settings",
          onBack: () => setProject(false),
          children: (
            <div className="set-fact">
              <span className="set-row-label">Saved in</span>
              <span className="set-fact-value">{projectFolder}</span>
            </div>
          ),
        }
      : null;
  return (
    <Sheet
      form={form}
      open={open}
      title="Settings"
      detent="half"
      step={pushed}
      onClose={() => {
        setProject(false);
        onClose();
      }}
    >
      <MenuRow
        icon="cloud-download"
        label="Models"
        detail="What this computer can transcribe, align and clean"
        onSelect={onModels}
      />
      {projectFolder !== undefined ? (
        <MenuRow
          icon="sliders-horizontal"
          label="Project settings"
          detail="Where this episode is saved"
          onSelect={() => setProject(true)}
        />
      ) : null}
    </Sheet>
  );
}
