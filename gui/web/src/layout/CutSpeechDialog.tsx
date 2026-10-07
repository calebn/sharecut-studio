import { useState } from "react";
import type { ExecuteResult } from "../commands/types";
import type { CutSpeechPrompt } from "../edit/cutSpeech";
import { useDaw } from "../state/useDaw";
import { useCommand } from "../ui";
import { CutSpeechDialogView } from "./CutSpeechDialogView";

/** Asks before a ripple cuts another speaker's speech; every choice runs through the command bus. */
export function CutSpeechDialog() {
  const { prompt, projectPath } = useDaw((s) => ({
    prompt: s.cutSpeechPrompt,
    projectPath: s.projectPath,
  }));
  const cutAnyway = useCommand("edit.cutSpeech.cutAnyway");
  const leaveGap = useCommand("edit.cutSpeech.leaveGap");
  const cancel = useCommand("edit.cutSpeech.cancel");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{
    prompt: CutSpeechPrompt;
    reason: string;
  } | null>(null);
  const live = prompt && prompt.projectPath === projectPath ? prompt : null;

  const choose = async (run: () => Promise<ExecuteResult>) => {
    if (!live) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await run();
      if (result.status === "disabled")
        setFailure({ prompt: live, reason: result.reason });
    } finally {
      setBusy(false);
    }
  };

  return (
    <CutSpeechDialogView
      speech={live?.speech ?? null}
      canLeaveGap={live?.leaveGap != null}
      busy={busy}
      error={failure && failure.prompt === live ? failure.reason : null}
      onCutAnyway={() => void choose(() => cutAnyway.run())}
      onLeaveGap={() => void choose(() => leaveGap.run())}
      onClose={() => void cancel.run()}
    />
  );
}
