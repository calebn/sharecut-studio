import { useState } from "react";
import { useViewportClass } from "../../hooks/useViewportClass";
import { copyText } from "../../record";
import { ConnectAgentSheet } from "./ConnectAgentSheet";
import { HelpSheet, type HelpStep } from "./HelpSheet";
import { localHostMcpUrl } from "./hostMcp";
import { SettingsSheet } from "./SettingsSheet";
import { useHelpReport } from "./useHelpReport";

export type AppSheetsProps = {
  helpOpen: boolean;
  agentOpen: boolean;
  settingsOpen: boolean;
  onCloseHelp: () => void;
  onCloseAgent: () => void;
  onCloseSettings: () => void;
  /** The step Help opens on; Report a problem when a command asks for it. */
  helpStart?: HelpStep;
  /** Help's and Settings' shortcuts row: opens the Palette. Absent where there is no Palette, so the row is too. */
  onShortcuts?: () => void;
  onModels: () => void;
  /** Goes to the Recent list. */
  onOpenRecent: () => void;
  hasProject: boolean;
  /** Set while an episode is open. */
  projectFolder?: string;
  /** Shows that folder in the file manager; absent where the app is not on that computer. */
  onRevealFolder?: () => void;
  /** Moves that folder; absent where the app is not on that computer. */
  onMoveFolder?: () => void;
  /** The agent that joined this episode, by name. */
  agentName: string | null;
};

/** Help, Connect agent and Settings: three sheets that share one place and never stack. */
export function AppSheets({
  helpOpen,
  agentOpen,
  settingsOpen,
  onCloseHelp,
  onCloseAgent,
  onCloseSettings,
  helpStart,
  onShortcuts,
  onModels,
  onOpenRecent,
  hasProject,
  projectFolder,
  onRevealFolder,
  onMoveFolder,
  agentName,
}: AppSheetsProps) {
  const phone = useViewportClass() === "phone";
  const form = phone ? "bottom" : "centered";
  const [step, setStep] = useState<HelpStep>("menu");
  const [wasOpen, setWasOpen] = useState(false);
  // Help always opens fresh, whichever way it was closed (Back, Done, or
  // another sheet opening over it).
  if (helpOpen !== wasOpen) {
    setWasOpen(helpOpen);
    setStep(helpOpen ? (helpStart ?? "menu") : "menu");
  }
  const report = useHelpReport(helpOpen);
  return (
    <>
      <HelpSheet
        form={form}
        open={helpOpen}
        onClose={onCloseHelp}
        step={step}
        onStepChange={setStep}
        onShortcuts={onShortcuts}
        description={report.description}
        onDescriptionChange={report.setDescription}
        preview={report.preview}
        onTogglePreview={report.togglePreview}
        phase={report.phase}
        blockedReason={report.blockedReason}
        onSend={report.send}
        onCopyReference={report.copyReference}
      />
      <ConnectAgentSheet
        form={form}
        open={agentOpen}
        onClose={onCloseAgent}
        url={localHostMcpUrl()}
        hasProject={hasProject}
        connected={agentName}
        onCopy={copyText}
        onOpenRecent={onOpenRecent}
      />
      <SettingsSheet
        form={phone ? "bottom" : "end"}
        open={settingsOpen}
        onClose={onCloseSettings}
        onModels={onModels}
        onShortcuts={onShortcuts}
        projectFolder={projectFolder}
        onRevealFolder={onRevealFolder}
        onMoveFolder={onMoveFolder}
      />
    </>
  );
}
