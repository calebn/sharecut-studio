import { shownTranscriptOf } from "../document/shownTranscript";
import {
  GuestScriptHost,
  type GuestScriptHostProps,
} from "../stage/hosts/GuestScriptHost";
import { useDawStore } from "../state/dawStore";

/** The guest Script over whatever transcript the store holds, as if every word were live. */
export function StoredGuestScriptHost(
  props: Omit<GuestScriptHostProps, "shown">,
) {
  const transcript = useDawStore((s) => s.project?.transcript);
  return (
    <GuestScriptHost
      {...props}
      shown={shownTranscriptOf(transcript ?? null, null, "", true)}
    />
  );
}
