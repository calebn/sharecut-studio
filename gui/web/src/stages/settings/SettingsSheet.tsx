import { THEME_OPTIONS, useTheme } from "../../hooks/useTheme";
import { Sheet } from "../../system/Sheet";
import { Button, SegmentedControl, ToggleButton } from "../../ui";
import { MenuRow } from "./MenuRow";

export type SettingsSheetProps = {
  /** `end` is the 400 px side panel on desktop and tablet; `bottom` is the phone's sheet. */
  form: "end" | "bottom";
  open: boolean;
  onClose: () => void;
  /** Opens the Models sheet. */
  onModels: () => void;
  /** Opens the shortcuts reference. Left out where there is none (Home), so the row is absent. */
  onShortcuts?: () => void;
  /** The folder the open episode is saved in; absent on Home, where no episode is open. */
  projectFolder?: string;
  /** Shows that folder in the computer's file manager. Left out where the app is not on that computer. */
  onRevealFolder?: () => void;
  /** Asks for a folder on this computer and moves the episode there. Left out where the app is not on that computer. */
  onMoveFolder?: () => void;
};

export function SettingsSheet({
  form,
  open,
  onClose,
  onModels,
  onShortcuts,
  projectFolder,
  onRevealFolder,
  onMoveFolder,
}: SettingsSheetProps) {
  const { preference, setPreference } = useTheme();
  return (
    <Sheet
      form={form}
      open={open}
      title="Settings"
      detent="half"
      panelClassName="settings-sheet"
      onClose={onClose}
    >
      <div className="set-fact">
        <span className="set-row-label">Appearance</span>
        <SegmentedControl label="Appearance">
          {THEME_OPTIONS.map((option) => (
            <ToggleButton
              key={option.id}
              quiet
              pressed={preference === option.id}
              onClick={() => setPreference(option.id)}
            >
              {option.label}
            </ToggleButton>
          ))}
        </SegmentedControl>
      </div>
      {projectFolder !== undefined ? (
        <div className="set-fact">
          <span className="set-row-label">Saved in</span>
          <span className="set-fact-value">{projectFolder}</span>
          {onRevealFolder || onMoveFolder ? (
            <div className="set-fact-actions">
              {onMoveFolder ? (
                <Button onClick={onMoveFolder}>Move…</Button>
              ) : null}
              {onRevealFolder ? (
                <Button onClick={onRevealFolder}>Reveal in folder</Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <MenuRow
        icon="cloud-download"
        label="Models"
        detail="What this computer can transcribe, align and clean"
        onSelect={onModels}
      />
      {onShortcuts ? (
        <MenuRow
          icon="keyboard"
          label="Keyboard shortcuts"
          detail="Every command and its key"
          onSelect={onShortcuts}
        />
      ) : null}
    </Sheet>
  );
}
