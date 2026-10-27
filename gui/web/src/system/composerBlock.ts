import { BUSY_REASON } from "../ui/disabledReason";
import type { ComposerProps } from "./Composer";

const WRITE_REASON = "Write a comment to post.";

/** Why the submit is off, or undefined when it can fire. */
export function composerBlock(
  props: Pick<ComposerProps, "body" | "state">,
): string | undefined {
  if (props.state === "posting") return BUSY_REASON;
  if (!props.body.trim()) return WRITE_REASON;
  return undefined;
}
