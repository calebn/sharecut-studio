import { BUSY_REASON } from "../ui/disabledReason";
import type { ComposerProps } from "./Composer";

const WRITE_REASON = "Write a comment to post.";
const NAME_REASON = "Add your name to post.";

/** Why the submit is off, or undefined when it can fire. */
export function composerBlock(
  props: Pick<ComposerProps, "body" | "name" | "state" | "disabledReason">,
): string | undefined {
  if (props.disabledReason) return props.disabledReason;
  if (props.state === "posting") return BUSY_REASON;
  if (props.name?.required && !props.name.value.trim()) return NAME_REASON;
  if (!props.body.trim()) return WRITE_REASON;
  return undefined;
}
