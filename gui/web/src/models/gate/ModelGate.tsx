import { type RefObject, useEffect, useRef } from "react";
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
  const ownPrimary = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const primary = primaryRef ?? ownPrimary;
  const phase = prompt?.phase;
  const previous = useRef(phase);
  useEffect(() => {
    const before = previous.current;
    previous.current = phase;
    if (phase === "downloading" && before !== "downloading") {
      cancelRef.current?.focus();
    } else if (before === "downloading" && phase !== undefined) {
      primary.current?.focus();
    }
  }, [phase, primary]);
  if (!prompt) {
    return null;
  }
  return (
    <div className="model-gate-actions">
      {phase === "downloading" ? (
        <Button ref={cancelRef} onClick={gate.cancelDownload}>
          Cancel download
        </Button>
      ) : (
        <>
          <Button
            ref={primary}
            variant="primary"
            disabledReason={phase === "ask" ? prompt.blockedReason : undefined}
            onClick={gate.accept}
          >
            {PRIMARY_LABEL[prompt.phase]}
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
