/** Stable entry point for the DAW command registry. Keep registration order here. */
import {
  registerClipboardCommands,
  registerClipMoveCommands,
  registerPrimaryEditingCommands,
} from "./editing";
import { registerHistoryCommands } from "./history";
import { registerHostCommands } from "./host";
import { registerNavigationCommands } from "./navigation";
import { registerProjectMediaCommands } from "./projectMedia";
import { registerTightenCommands } from "./tighten";
import { registerTrackMixCommands } from "./trackMix";
import { registerTranscriptIgnoreCommands } from "./transcriptIgnore";
import { registerTranscriptReviewCommands } from "./transcriptReview";
import {
  registerPaletteCommands,
  registerTranscriptViewCommands,
  registerViewCommands,
  registerViewFocusCommands,
} from "./view";

export { setBladeCommandRunner } from "./editing";
export { _resetExportDeliverablesInFlightForTests } from "./host";
export { _resetProjectOpenInFlightForTests } from "./projectMedia";
export { _resetTrackMutateChainForTests } from "./trackMutation";

export function registerDawCommands(): void {
  registerNavigationCommands();
  registerPrimaryEditingCommands();
  registerViewCommands();
  registerHistoryCommands();
  registerClipboardCommands();
  registerPaletteCommands();
  registerHostCommands();
  registerProjectMediaCommands();
  registerTranscriptViewCommands();
  registerClipMoveCommands();
  registerViewFocusCommands();
  registerTightenCommands();
  registerTrackMixCommands();
  registerTranscriptIgnoreCommands();
  registerTranscriptReviewCommands();
}
