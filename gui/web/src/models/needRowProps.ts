import type { StatusRowProps } from "../system/StatusRow";
import { capabilityOf, plainSize } from "./capability";
import { progressText } from "./format";
import type { ModelNeedRowViewProps } from "./ModelNeedRow";
import type { ModelFailure, ModelState } from "./types";

export function progressOf(state: ModelState): number | undefined {
  return state.kind === "downloading" && state.total
    ? state.bytes / state.total
    : undefined;
}

export function bytesDetail(state: ModelState, size: string): string {
  return state.kind === "downloading" ? progressText(state) : size;
}

function failureOf(state: ModelState): ModelFailure | null {
  return state.kind === "failed" ? state.failure : null;
}

/** The Status row a missing, working or failed model shows, as props, so a host can render it or hand it to the frame alert slot. */
export function needRowProps({
  model,
  state,
  blockedReason,
  onGet,
  onCancel,
  onManage,
  onCheck,
}: Omit<ModelNeedRowViewProps, "placement" | "children">): StatusRowProps {
  const { what, name } = capabilityOf(model.id, model.label);
  const size = plainSize(model.size);
  const working = state.kind === "downloading" || state.kind === "queued";
  const failure = failureOf(state);
  const manage = onManage
    ? { label: "Manage", name: "Manage models", onAction: onManage }
    : undefined;
  if (state.kind === "unsupported") {
    return { state: "queued", title: state.hint };
  }
  if (state.kind === "checking" || state.kind === "unavailable") {
    return {
      state: state.kind === "checking" ? "running" : "failed",
      title:
        state.kind === "checking"
          ? `Checking ${what}`
          : `Couldn't check ${what}`,
      action:
        state.kind === "unavailable" && onCheck
          ? {
              label: "Try again",
              name: `Try again to check ${name} status`,
              onAction: onCheck,
            }
          : undefined,
      secondaryAction: manage,
    };
  }
  if (working) {
    return {
      state: "running",
      title: `Getting ${what}`,
      detail: bytesDetail(state, size),
      progress: progressOf(state),
      barLabel: `Getting ${what}`,
      action: {
        label: "Cancel",
        name: `Cancel ${what} download`,
        onAction: onCancel,
      },
    };
  }
  if (failure) {
    return {
      state: "failed",
      title: `Couldn't get ${what}`,
      detail: failure.plain,
      action: {
        label: "Try again",
        name: `Try again to get ${what}`,
        icon: "cloud-download",
        onAction: onGet,
        disabledReason: blockedReason,
      },
      secondaryAction: manage,
    };
  }
  return {
    state: "needs-you",
    title:
      state.kind === "update_needed"
        ? `Needs an update for ${what}`
        : `Needs ${what}`,
    detail: size,
    action: {
      label: state.kind === "update_needed" ? "Update" : "Get",
      name: `${state.kind === "update_needed" ? "Update" : "Get"} ${what}`,
      icon: "cloud-download",
      onAction: onGet,
      disabledReason: blockedReason,
    },
    secondaryAction: manage,
  };
}
