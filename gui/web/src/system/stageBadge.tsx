import type { ReactNode } from "react";
import type { StageId } from "../types/stage";
import {
  Badge,
  type RecordBadge,
  RecordBadgeView,
  type StageBarProps,
} from "./StageBar";

/** A stage's badge, or null. Record's `failed` badge outranks its room badge. */
export function stageBadge(
  id: StageId,
  badges: StageBarProps["badges"],
  record: RecordBadge | undefined,
): ReactNode {
  const given = badges?.[id];
  if (id === "record" && record && given?.kind !== "failed") {
    return record.kind === "idle" ? null : <RecordBadgeView badge={record} />;
  }
  return given ? <Badge badge={given} /> : null;
}
