import { type ReactNode, useEffect, useRef, useState } from "react";
import { runPointerCommand } from "../commands/pointer";
import { askConfirm } from "../feedback/ask";
import { canManageProjects } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { percentOf } from "../system/progress";
import { StatusRow } from "../system/StatusRow";
import { SystemIcon } from "../system/SystemIcon";
import { Button, Menu, MenuItem } from "../ui";
import { useDisabledReasonNote } from "../ui/disabledReason";
import { type ModelActivity, modelActivity } from "./activity";
import {
  capabilityOf,
  type NeedTarget,
  plainSize,
  rowInstalled,
} from "./capability";
import { progressText } from "./format";
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
  /** Sheet rows only: Remove in the more menu of an installed or out-of-date model. */
  onRemove?: () => void;
  /** Replaces "Needs {what}" while the model is plainly missing, as a Check says what it risks. */
  idleTitle?: string;
  /** A control that belongs under the row, such as the Whisper size. */
  children?: ReactNode;
};

function progressOf(state: ModelState): number | undefined {
  return state.kind === "downloading" && state.total
    ? state.bytes / state.total
    : undefined;
}

function bytesDetail(state: ModelState, size: string): string {
  return state.kind === "downloading" ? progressText(state) : size;
}

function failureOf(state: ModelState): ModelFailure | null {
  return state.kind === "failed" ? state.failure : null;
}

/**
 * Pressing Get, Cancel or Try again swaps the row's button for another, so the focused one unmounts.
 * While focus is on the row, the swap hands it to the control that takes its place.
 */
function useControlHandoff(control: string, change: string) {
  const rowRef = useRef<HTMLDivElement>(null);
  const holdsFocus = useRef(false);
  useEffect(() => {
    const row = rowRef.current;
    if (!holdsFocus.current || !row) {
      return;
    }
    const active = document.activeElement;
    holdsFocus.current = false;
    if (active && active !== document.body && !row.contains(active)) {
      return;
    }
    row.querySelector<HTMLElement>(control)?.focus();
  }, [change, control]);
  const act = (run: () => void) => () => {
    holdsFocus.current = true;
    run();
  };
  return { rowRef, act };
}

function NeedRow({
  model,
  state,
  blockedReason,
  idleTitle,
  onGet,
  onCancel,
  onManage,
}: Omit<ModelNeedRowViewProps, "placement" | "children">) {
  const { rowRef, act } = useControlHandoff(
    ".sys-status-actions > :last-child",
    state.kind,
  );
  const { what } = capabilityOf(model.id, model.label);
  const size = plainSize(model.size);
  const working = state.kind === "downloading" || state.kind === "queued";
  const failure = failureOf(state);
  const manage = onManage
    ? { label: "Manage", name: "Manage models", onAction: onManage }
    : undefined;
  const update = state.kind === "update_needed";
  const row = working ? (
    <StatusRow
      state="running"
      title={`Getting ${what}`}
      detail={bytesDetail(state, size)}
      progress={progressOf(state)}
      barLabel={`Getting ${what}`}
      action={{
        label: "Cancel",
        name: `Cancel ${what} download`,
        onAction: act(onCancel),
      }}
    />
  ) : failure ? (
    <StatusRow
      state="failed"
      title={`Couldn't get ${what}`}
      detail={failure.plain}
      action={{
        label: "Try again",
        name: `Try getting ${what} again`,
        icon: "cloud-download",
        onAction: act(onGet),
        disabledReason: blockedReason,
      }}
      secondaryAction={manage}
    />
  ) : (
    <StatusRow
      state="needs-you"
      title={
        update ? `Needs an update for ${what}` : (idleTitle ?? `Needs ${what}`)
      }
      detail={size}
      action={{
        label: update ? "Update" : "Get",
        name: `${update ? "Update" : "Get"} ${what}`,
        icon: "cloud-download",
        onAction: act(onGet),
        disabledReason: blockedReason,
      }}
      secondaryAction={manage}
    />
  );
  return (
    <div ref={rowRef} className="sys-need-slot">
      {row}
    </div>
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
  onRemove,
  children,
}: Omit<ModelNeedRowViewProps, "placement" | "onManage">) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { name, icon } = capabilityOf(model.id, model.label);
  const size = plainSize(model.size);
  const reason = useDisabledReasonNote(blockedReason, "sys-need-meta");
  const { rowRef, act } = useControlHandoff(
    ".sys-need-control button",
    state.kind,
  );
  const working = state.kind === "downloading" || state.kind === "queued";
  const known = progressOf(state);
  const get = state.kind === "update_needed" ? "Update" : "Get";
  const getting =
    state.kind === "missing" ||
    state.kind === "update_needed" ||
    state.kind === "failed";

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
        {state.kind === "downloading" ? (
          <span
            className="sr-only"
            role="progressbar"
            aria-label={`Getting ${name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={known === undefined ? undefined : percentOf(known)}
            aria-valuetext={progressText(state)}
          />
        ) : null}
        <span className="sr-only" role="status">
          {state.kind === "failed"
            ? `Couldn't get ${name}. ${state.failure.plain}`
            : ""}
        </span>
        <div className="sys-need-control">
          {working ? (
            <Button
              className="sys-need-cancel"
              aria-label={`Cancel ${name} download`}
              onClick={act(onCancel)}
            >
              <SystemIcon name="progress-ring" size={20} progress={known} />
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
          {onRemove &&
          (state.kind === "installed" || state.kind === "update_needed") ? (
            <Menu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              label={`More for ${name}`}
              className="ui-menu-root sys-menu"
              trigger={(props) => (
                <Button {...props} aria-label={`More for ${name}`}>
                  <SystemIcon name="ellipsis" size={16} />
                </Button>
              )}
            >
              <MenuItem
                disabledReason={blockedReason}
                onSelect={() => {
                  setMenuOpen(false);
                  onRemove();
                }}
              >
                {`Remove ${name}`}
              </MenuItem>
            </Menu>
          ) : null}
        </div>
      </div>
      {children ? <div className="sys-need-extra">{children}</div> : null}
    </div>
  );
}

/** One model's need, shown in place: the answer to "this step needs a model". Presentational. */
export function ModelNeedRowView(props: ModelNeedRowViewProps) {
  const { placement, children, idleTitle, ...row } = props;
  return placement === "list" ? (
    <ListRow {...row}>{children}</ListRow>
  ) : (
    <NeedRow idleTitle={idleTitle} {...row} />
  );
}

async function removeWithConfirm(
  model: NeedTarget,
  remove: ReturnType<typeof useModels>["remove"],
): Promise<void> {
  const { name } = capabilityOf(model.id, model.label);
  const size = plainSize(model.size);
  const sure = await askConfirm({
    title: `Remove ${name}?`,
    message: `This frees about ${size}. Get downloads it again.`,
    keepLabel: "Keep it",
    actionLabel: "Remove",
    danger: false,
  });
  if (!sure) {
    return;
  }
  const outcome = await remove(model.id, model.variant);
  const { announceStatus } = useDawStore.getState();
  if (outcome.kind === "ok") {
    announceStatus(`${name} removed.`);
  } else if (outcome.kind === "busy") {
    announceStatus(`${name} stays: a download or job is running.`, {
      tone: "error",
    });
  } else {
    announceStatus(`Couldn't remove ${name}. ${outcome.plain}`, {
      tone: "error",
    });
  }
}

export type ModelNeedRowProps = {
  model: NeedTarget;
  placement?: ModelNeedPlacement;
  /** Called when the person presses Get, Update or Try again, as the download starts. */
  onGet?: () => void;
  onManage?: () => void;
  idleTitle?: string;
  children?: ReactNode;
};

export function ModelNeedRow({
  model,
  placement = "need",
  onGet,
  onManage,
  idleTitle,
  children,
}: ModelNeedRowProps) {
  const { models, busy, download, cancel, remove } = useModels();
  const mayManage = useDawStore((s) => canManageProjects(s.projectPath));
  const manage =
    placement === "need" && mayManage
      ? (onManage ?? (() => runPointerCommand("models.open")))
      : undefined;
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
      idleTitle={idleTitle}
      blockedReason={activity.blockedReason}
      onGet={() => {
        onGet?.();
        void download(
          [model.id],
          sizeAsked ? { whisperModel: model.variant ?? undefined } : undefined,
        );
      }}
      onCancel={() => void cancel()}
      onManage={manage}
      onRemove={
        placement === "list"
          ? () => void removeWithConfirm(model, remove)
          : undefined
      }
    >
      {children}
    </ModelNeedRowView>
  );
}
