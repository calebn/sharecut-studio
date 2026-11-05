import { useId, useState } from "react";
import { Sheet } from "../../system/Sheet";
import { StatusRow } from "../../system/StatusRow";
import { Button, Field, InlineError } from "../../ui";
import type { DrawerDetent } from "../../ui/BottomSheet";
import { useDisabledReasonNote } from "../../ui/disabledReason";
import {
  INCLUDES_LINE,
  type PreviewState,
  PUBLIC_LINE,
  QUEUED_DETAIL,
  type ReportPhase,
  SAVED_LOCALLY,
  sizeLabel,
} from "./helpReport";
import { MenuRow } from "./MenuRow";

export const GUIDES_URL = "https://ux.sharecut.studio/";

export type HelpStep = "menu" | "report";

export type HelpSheetProps = {
  /** `bottom` is the phone's sheet; `centered` everywhere else. */
  form: "centered" | "bottom";
  open: boolean;
  onClose: () => void;
  step: HelpStep;
  onStepChange: (step: HelpStep) => void;
  /** Opens the Palette. Left out where there is none (Home), so the row is absent. */
  onShortcuts?: () => void;
  guidesHref?: string;
  description: string;
  onDescriptionChange: (value: string) => void;
  preview: PreviewState;
  onTogglePreview: () => void;
  phase: ReportPhase;
  /** Why Send report cannot be pressed yet. */
  blockedReason?: string;
  onSend: () => void;
  onCopyReference: () => Promise<boolean>;
  detent?: DrawerDetent | "fit";
};

function Preview({
  preview,
  onToggle,
}: {
  preview: PreviewState;
  onToggle: () => void;
}) {
  const panel = useId();
  const open = preview.kind !== "closed";
  return (
    <div className="set-preview">
      <button
        type="button"
        className="sys-text-btn"
        aria-expanded={open}
        aria-controls={open ? panel : undefined}
        onClick={onToggle}
      >
        Preview what's included
      </button>
      {open ? (
        <div id={panel} className="set-preview-body" role="status">
          {preview.kind === "loading" ? <p>Preparing the report…</p> : null}
          {preview.kind === "failed" ? (
            <InlineError message={preview.reason} />
          ) : null}
          {preview.kind === "ready" ? (
            <>
              <p>
                {preview.bundle.files.length} files,{" "}
                {sizeLabel(preview.bundle.sizeBytes)}. Saved on this computer.
              </p>
              <ul className="set-preview-files">
                {preview.bundle.files.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SendButton({
  label,
  blockedReason,
  onSend,
}: {
  label: string;
  blockedReason?: string;
  onSend: () => void;
}) {
  const reason = useDisabledReasonNote(blockedReason, "set-line");
  return (
    <div className="set-send">
      {reason.note}
      <Button
        variant="primary"
        disabledReason={blockedReason}
        {...reason.describedBy}
        onClick={onSend}
      >
        {label}
      </Button>
    </div>
  );
}

function Result({
  phase,
  onCopyReference,
}: {
  phase: Exclude<ReportPhase, { kind: "editing" }>;
  onCopyReference: () => Promise<boolean>;
}) {
  const [copied, setCopied] = useState(false);
  if (phase.kind === "sending") {
    return <StatusRow state="running" title="Sending the report…" />;
  }
  if (phase.kind === "sent") {
    return (
      <StatusRow
        state="done"
        title="Sent."
        detail={`Reference ${phase.reference}`}
        action={{
          label: copied ? "Copied" : "Copy",
          name: "Copy reference",
          icon: "copy",
          onAction: () => void onCopyReference().then(setCopied),
        }}
      />
    );
  }
  if (phase.kind === "queued") {
    return (
      <StatusRow state="queued" title={SAVED_LOCALLY} detail={QUEUED_DETAIL} />
    );
  }
  if (phase.kind === "saved") {
    return (
      <>
        <StatusRow state="done" title={SAVED_LOCALLY} detail={phase.path} />
        {phase.supportHref ? (
          <p className="set-line">
            Attach it to a support request.{" "}
            <a href={phase.supportHref} target="_blank" rel="noreferrer">
              Open support
            </a>
          </p>
        ) : null}
      </>
    );
  }
  return (
    <StatusRow
      state="failed"
      title="Couldn't send the report."
      detail="It is saved on this computer."
      details={phase.reason}
    />
  );
}

/**
 * Help: three rows, and Report a problem as a step inside the same sheet.
 * Presentational: the report's state comes in as props.
 */
export function HelpSheet({
  form,
  open,
  onClose,
  step,
  onStepChange,
  onShortcuts,
  guidesHref = GUIDES_URL,
  description,
  onDescriptionChange,
  preview,
  onTogglePreview,
  phase,
  blockedReason,
  onSend,
  onCopyReference,
  detent,
}: HelpSheetProps) {
  const editing = phase.kind === "editing" || phase.kind === "failed";
  const finished =
    phase.kind === "sent" || phase.kind === "queued" || phase.kind === "saved";
  const report =
    step === "report"
      ? {
          title: "Report a problem",
          onBack: () => onStepChange("menu"),
          children: (
            <>
              {phase.kind !== "editing" ? (
                <Result phase={phase} onCopyReference={onCopyReference} />
              ) : null}
              {editing ? (
                <>
                  <Field label="What went wrong?">
                    {(control) => (
                      <textarea
                        {...control}
                        className="set-description"
                        rows={3}
                        maxLength={4000}
                        value={description}
                        onChange={(event) =>
                          onDescriptionChange(event.target.value)
                        }
                      />
                    )}
                  </Field>
                  <p className="set-line">{INCLUDES_LINE}</p>
                  <p className="set-line">{PUBLIC_LINE}</p>
                  <Preview preview={preview} onToggle={onTogglePreview} />
                </>
              ) : null}
            </>
          ),
        }
      : null;
  const footer =
    step !== "report" ? undefined : editing ? (
      <SendButton
        label={phase.kind === "failed" ? "Try again" : "Send report"}
        blockedReason={blockedReason}
        onSend={onSend}
      />
    ) : finished ? (
      <Button variant="primary" onClick={onClose}>
        Done
      </Button>
    ) : undefined;
  return (
    <Sheet
      form={form}
      open={open}
      title="Help"
      detent={detent ?? "half"}
      step={report}
      footer={footer}
      onClose={onClose}
    >
      {onShortcuts ? (
        <MenuRow
          icon="keyboard"
          label="Shortcuts and gestures"
          onSelect={onShortcuts}
        />
      ) : null}
      <MenuRow
        icon="flag"
        label="Report a problem"
        onSelect={() => onStepChange("report")}
      />
      <MenuRow icon="book-open" label="Guides" href={guidesHref} />
    </Sheet>
  );
}
