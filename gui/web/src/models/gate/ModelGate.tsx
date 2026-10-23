import { type RefObject, useRef } from "react";
import { Button, Dialog } from "../../ui";
import { capitalize } from "../format";
import { ModelRow } from "../ModelRow";
import type { GatePrompt, ModelGate } from "./useModelGate";

type Props = { gate: ModelGate };

const PRIMARY_LABEL = {
  ask: "Download",
  downloading: "Downloading…",
  failed: "Retry",
  ready: "Continue",
} as const;

/** What the prompt says: the purpose, the size, and that it stays on this computer. */
export function ModelGateBody({ prompt }: { prompt: GatePrompt }) {
  const purpose = prompt.purpose ? `${capitalize(prompt.purpose)}. ` : "";
  const stored = prompt.size
    ? `About ${prompt.size.replace(/^~/, "")}, stored on this computer.`
    : "Stored on this computer.";
  return (
    <div className="stack tight model-gate-body">
      <p>
        {purpose}
        {stored}
      </p>
      <ul className="stack tight model-list">
        <ModelRow model={prompt.view} action={{ kind: "none" }} />
      </ul>
    </div>
  );
}

export function ModelGateFooter({
  gate,
  primaryRef,
}: Props & { primaryRef?: RefObject<HTMLButtonElement | null> }) {
  const { prompt } = gate;
  if (!prompt) {
    return null;
  }
  const { phase } = prompt;
  return (
    <div className="model-gate-actions">
      {phase === "downloading" ? (
        <Button onClick={gate.cancelDownload}>Cancel download</Button>
      ) : (
        <>
          <Button
            ref={primaryRef}
            variant="primary"
            disabledReason={phase === "ask" ? prompt.blockedReason : undefined}
            onClick={gate.accept}
          >
            {PRIMARY_LABEL[phase]}
          </Button>
          <Button onClick={gate.decline}>Not now</Button>
          {phase === "ask" ? (
            <Button variant="link" onClick={gate.openModels}>
              Manage models
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The prompt as its own dialog; a bottom sheet on a phone. */
export function ModelGateDialog({ gate }: Props) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  const { prompt } = gate;
  return (
    <Dialog
      open={prompt !== null}
      onClose={gate.decline}
      title={prompt ? `Download ${prompt.label}?` : "Download model?"}
      closeDisabled={prompt?.phase === "downloading"}
      initialFocusRef={primaryRef}
      footer={<ModelGateFooter gate={gate} primaryRef={primaryRef} />}
    >
      {prompt ? <ModelGateBody prompt={prompt} /> : null}
    </Dialog>
  );
}

/** The prompt inside a dialog that is already open, so no dialog opens from another dialog. */
export function ModelGatePanel({ gate }: Props) {
  if (!gate.prompt) {
    return null;
  }
  return (
    <div className="stack model-gate-panel">
      <ModelGateBody prompt={gate.prompt} />
      <ModelGateFooter gate={gate} />
    </div>
  );
}

/** After "Not now": says what is missing and that the action asks again, with a way to Models. */
export function ModelGateHint({
  gate,
  actionLabel,
}: Props & { actionLabel: string }) {
  if (!gate.declined) {
    return null;
  }
  return (
    <p className="model-gate-hint" role="status">
      {gate.declined.label} is not downloaded. {actionLabel} will ask again.{" "}
      <Button variant="link" onClick={gate.openModels}>
        Manage models
      </Button>
    </p>
  );
}
