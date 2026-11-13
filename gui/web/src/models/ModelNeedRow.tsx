import { type ReactNode, useEffect, useRef, useState } from "react";
import { percentOf } from "../system/progress";
import { StatusRow } from "../system/StatusRow";
import { SystemIcon } from "../system/SystemIcon";
import { Button, Menu, MenuItem } from "../ui";
import { useDisabledReasonNote } from "../ui/disabledReason";
import { capabilityOf, type NeedTarget, plainSize } from "./capability";
import { progressText } from "./format";
import { bytesDetail, needRowProps, progressOf } from "./needRowProps";
import type { DownloadOutcome, ModelState } from "./types";
import { useModelNeed } from "./useModelNeed";

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
  onCheck?: () => void;
  /** The Manage link to the Models sheet; absent inside the sheet itself. */
  onManage?: () => void;
  /** Sheet rows only: Remove in the more menu of an installed or out-of-date model. */
  onRemove?: () => void;
  /** A control that belongs under the row, such as the Whisper size. */
  children?: ReactNode;
};

function NeedRow(props: Omit<ModelNeedRowViewProps, "placement" | "children">) {
  return <StatusRow {...needRowProps(props)} />;
}

const META: Record<Exclude<ModelState["kind"], "unsupported">, string> = {
  checking: "Checking status",
  unavailable: "Status unavailable",
  installed: "Installed",
  missing: "Not installed",
  update_needed: "Update available",
  queued: "Waiting",
  downloading: "Downloading",
  failed: "Download failed",
};

function listMeta(state: ModelState, size: string): string {
  if (state.kind === "unsupported") {
    return "Not available on this device yet";
  }
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
  onCheck,
  children,
}: Omit<ModelNeedRowViewProps, "placement" | "onManage">) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { name, icon } = capabilityOf(model.id, model.label);
  const size = plainSize(model.size);
  const reason = useDisabledReasonNote(blockedReason, "sys-need-meta");
  const rowRef = useRef<HTMLDivElement>(null);
  const holdsFocus = useRef(false);
  const working = state.kind === "downloading" || state.kind === "queued";
  const known = progressOf(state);
  const getting = state.kind === "missing" || state.kind === "failed";

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
          {state.kind === "unavailable" && onCheck ? (
            <Button
              aria-label={`Try again to check ${name} status`}
              onClick={onCheck}
            >
              Try again
            </Button>
          ) : working ? (
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
              aria-label={`${state.kind === "failed" ? "Try again" : "Get"} ${name}`}
              disabledReason={blockedReason}
              {...reason.describedBy}
              onClick={act(onGet)}
            >
              <SystemIcon name="cloud-download" size={14} />
              {state.kind === "failed" ? "Try again" : "Get"}
            </Button>
          ) : null}
          {state.kind === "update_needed" ||
          (onRemove && state.kind === "installed") ? (
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
              {state.kind === "update_needed" ? (
                <MenuItem
                  disabledReason={blockedReason}
                  onSelect={act(() => {
                    setMenuOpen(false);
                    onGet();
                  })}
                >{`Update ${name}`}</MenuItem>
              ) : null}
              {onRemove ? (
                <MenuItem
                  disabledReason={blockedReason}
                  onSelect={() => {
                    setMenuOpen(false);
                    onRemove();
                  }}
                >
                  {`Remove ${name}`}
                </MenuItem>
              ) : null}
            </Menu>
          ) : null}
        </div>
      </div>
      {children ? <div className="sys-need-extra">{children}</div> : null}
    </div>
  );
}

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
  /** Called when the person presses Get, Update or Try again, as the download starts. */
  onGet?: (outcome: Promise<DownloadOutcome>) => void;
  onManage?: () => void;
  children?: ReactNode;
};

export function ModelNeedRow({
  model,
  placement = "need",
  onGet,
  onManage,
  children,
}: ModelNeedRowProps) {
  const view = useModelNeed(model, placement, { onGet, onManage });
  if (!view) {
    return null;
  }
  return (
    <ModelNeedRowView placement={placement} {...view}>
      {children}
    </ModelNeedRowView>
  );
}
