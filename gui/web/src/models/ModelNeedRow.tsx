import { type ReactNode, useEffect, useRef } from "react";
import { StatusRow } from "../system/StatusRow";
import { SystemIcon } from "../system/SystemIcon";
import { Button } from "../ui";
import { useDisabledReasonNote } from "../ui/disabledReason";
import { type ModelActivity, modelActivity } from "./activity";
import {
  capabilityOf,
  type NeedTarget,
  plainSize,
  rowInstalled,
} from "./capability";
import { formatBytes } from "./format";
import type { ModelFailure, ModelState } from "./types";
import { useModels } from "./useModels";

export type ModelNeedPlacement =
  /** Inside a Job row or a Check row: "Needs the transcription model · 1.6 GB" and Get. */
  | "need"
  /** In the Models sheet: icon, capability, "Not installed · 360 MB", and the trailing control. */
  | "list";

export type ModelNeedRowViewProps = {
  placement: ModelNeedPlacement;
  model: NeedTarget;
  state: ModelState;
  /** Why Get is unavailable now: another download holds the one slot. */
  blockedReason?: string;
  onGet: () => void;
  onCancel: () => void;
  /** The Manage link to the Models sheet; absent inside the sheet itself. */
  onManage?: () => void;
  /** A control that belongs under the row, such as the Whisper size. */
  children?: ReactNode;
};

function progressOf(state: ModelState): number | undefined {
  return state.kind === "downloading" && state.total
    ? state.bytes / state.total
    : undefined;
}

function bytesDetail(state: ModelState, size: string): string {
  if (state.kind !== "downloading") {
    return size;
  }
  return state.total != null
    ? `${formatBytes(state.bytes)} of ${formatBytes(state.total)}`
    : `${formatBytes(state.bytes)} downloaded`;
}

function failureOf(state: ModelState): ModelFailure | null {
  return state.kind === "failed" ? state.failure : null;
}

function NeedRow({
  model,
  state,
  blockedReason,
  onGet,
  onCancel,
  onManage,
}: Omit<ModelNeedRowViewProps, "placement" | "children">) {
  const { what } = capabilityOf(model.id, model.label);
  const size = plainSize(model.size);
  const working = state.kind === "downloading" || state.kind === "queued";
  const failure = failureOf(state);
  const manage = onManage
    ? { label: "Manage", name: "Manage models", onAction: onManage }
    : undefined;
  if (working) {
    return (
      <StatusRow
        state="running"
        title={`Getting ${what}`}
        detail={bytesDetail(state, size)}
        progress={progressOf(state)}
        barLabel={`Getting ${what}`}
        action={{
          label: "Cancel",
          name: `Cancel ${what} download`,
          onAction: onCancel,
        }}
      />
    );
  }
  if (failure) {
    return (
      <StatusRow
        state="failed"
        title={`Couldn't get ${what}`}
        detail={failure.plain}
        action={{
          label: "Try again",
          name: `Try getting ${what} again`,
          icon: "cloud-download",
          onAction: onGet,
          disabledReason: blockedReason,
        }}
        secondaryAction={manage}
      />
    );
  }
  return (
    <StatusRow
      state="needs-you"
      title={
        state.kind === "update_needed"
          ? `Needs an update for ${what}`
          : `Needs ${what}`
      }
      detail={size}
      action={{
        label: state.kind === "update_needed" ? "Update" : "Get",
        name: `${state.kind === "update_needed" ? "Update" : "Get"} ${what}`,
        icon: "cloud-download",
        onAction: onGet,
        disabledReason: blockedReason,
      }}
      secondaryAction={manage}
    />
  );
}

const META: Record<ModelState["kind"], string> = {
  installed: "Installed",
  missing: "Not installed",
  update_needed: "Update available",
  queued: "Waiting",
  downloading: "Downloading",
  failed: "Download failed",
};

function listMeta(state: ModelState, size: string): string {
  if (state.kind === "downloading") {
    return bytesDetail(state, size);
  }
  if (state.kind === "failed") {
    return state.failure.plain;
  }
  return `${META[state.kind]} · ${size}`;
}

function ListRow({
  model,
  state,
  blockedReason,
  onGet,
  onCancel,
  children,
}: Omit<ModelNeedRowViewProps, "placement" | "onManage">) {
  const { name, icon } = capabilityOf(model.id, model.label);
  const size = plainSize(model.size);
  const reason = useDisabledReasonNote(blockedReason, "sys-need-meta");
  const rowRef = useRef<HTMLDivElement>(null);
  const holdsFocus = useRef(false);
  const working = state.kind === "downloading" || state.kind === "queued";
  const get = state.kind === "update_needed" ? "Update" : "Get";
  const getting =
    state.kind === "missing" ||
    state.kind === "update_needed" ||
    state.kind === "failed";

  useEffect(() => {
    const row = rowRef.current;
    if (!holdsFocus.current || !row) {
      return;
    }
    const active = document.activeElement;
    if (active && active !== document.body && !row.contains(active)) {
      holdsFocus.current = false;
      return;
    }
    holdsFocus.current = false;
    row.querySelector<HTMLElement>(".sys-need-control button")?.focus();
  }, [state.kind]);

  const act = (run: () => void) => () => {
    holdsFocus.current = true;
    run();
  };

  return (
    <div
      ref={rowRef}
      className="sys-need"
      data-placement="list"
      data-state={state.kind}
    >
      <div className="sys-need-line">
        <span className="sys-need-icon">
          <SystemIcon name={icon} size={20} />
        </span>
        <div className="sys-need-text">
          <span className="sys-need-name">{name}</span>
          <span
            className="sys-need-meta"
            data-failed={state.kind === "failed" || undefined}
          >
            {listMeta(state, size)}
          </span>
          {reason.note}
        </div>
        <div className="sys-need-control">
          {working ? (
            <Button
              className="sys-need-cancel"
              aria-label={`Cancel ${name} download`}
              onClick={act(onCancel)}
            >
              <SystemIcon
                name="progress-ring"
                size={20}
                progress={progressOf(state)}
              />
              <SystemIcon name="x" size={14} />
            </Button>
          ) : getting ? (
            <Button
              variant={state.kind === "failed" ? "primary" : "default"}
              aria-label={`${state.kind === "failed" ? "Try again" : get} ${name}`}
              disabledReason={blockedReason}
              {...reason.describedBy}
              onClick={act(onGet)}
            >
              <SystemIcon name="cloud-download" size={14} />
              {state.kind === "failed" ? "Try again" : get}
            </Button>
          ) : null}
        </div>
      </div>
      {children ? <div className="sys-need-extra">{children}</div> : null}
    </div>
  );
}

/** One model's need, shown in place: the answer to "this step needs a model". Presentational. */
export function ModelNeedRowView(props: ModelNeedRowViewProps) {
  const { placement, children, ...row } = props;
  return placement === "list" ? (
    <ListRow {...row}>{children}</ListRow>
  ) : (
    <NeedRow {...row} />
  );
}

export type ModelNeedRowProps = {
  model: NeedTarget;
  placement?: ModelNeedPlacement;
  onManage?: () => void;
  children?: ReactNode;
};

/**
 * The Model need row wired to the models provider: Get starts the download, the row follows its
 * progress, failure and Cancel, and it renders nothing once the model is in. A step that waits on
 * it resumes through `useModelResume`. Reusable inside any Job row or Check row.
 */
export function ModelNeedRow({
  model,
  placement = "need",
  onManage,
  children,
}: ModelNeedRowProps) {
  const { models, busy, download, cancel } = useModels();
  const row = models?.find((m) => m.id === model.id) ?? null;
  const sizeAsked = model.id === "whisper" && model.variant;
  const foreign = row !== null && sizeAsked && row.variant !== model.variant;
  const live = foreign ? null : row;
  const activity: ModelActivity = modelActivity(live, busy);
  if (placement === "need" && rowInstalled(row, model)) {
    return null;
  }
  const state: ModelState = live?.state ?? { kind: "missing" };
  return (
    <ModelNeedRowView
      placement={placement}
      model={model}
      state={state}
      blockedReason={activity.blockedReason}
      onGet={() =>
        void download(
          [model.id],
          sizeAsked ? { whisperModel: model.variant ?? undefined } : undefined,
        )
      }
      onCancel={() => void cancel()}
      onManage={onManage}
    >
      {children}
    </ModelNeedRowView>
  );
}
