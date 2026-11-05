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
  /** Help's first row: the Palette in a project, the gestures card on Home. */
  onShortcuts?: () => void;
  onModels: () => void;
  /** Goes to the Recent list. */
  onOpenRecent: () => void;
  hasProject: boolean;
  /** Set while an episode is open. */
  projectFolder?: string;
  /** Shows that folder in the file manager; absent where the app is not on that computer. */
  onRevealFolder?: () => void;
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
  onShortcuts,
  onModels,
  onOpenRecent,
  hasProject,
  projectFolder,
  onRevealFolder,
  agentName,
}: AppSheetsProps) {
  const form = useViewportClass() === "phone" ? "bottom" : "centered";
  const [step, setStep] = useState<HelpStep>("menu");
  const report = useHelpReport(helpOpen);
  const closeHelp = () => {
    setStep("menu");
    onCloseHelp();
  };
  return (
    <>
      <HelpSheet
        form={form}
        open={helpOpen}
        onClose={closeHelp}
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
        form={form}
        open={settingsOpen}
        onClose={onCloseSettings}
        onModels={onModels}
        onShortcuts={onShortcuts}
        projectFolder={projectFolder}
        onRevealFolder={onRevealFolder}
      />
    </>
  );
}
