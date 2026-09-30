/** Stable entry point for the DAW command registry. Keep registration order here. */
import { registerChapterCommands } from "./chapters";
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
import { registerTranscriptWordCommands } from "./transcriptWord";
import {
  registerPaletteCommands,
  registerTranscriptViewCommands,
  registerViewCommands,
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
  registerTightenCommands();
  registerTrackMixCommands();
  registerTranscriptIgnoreCommands();
  registerTranscriptReviewCommands();
  registerTranscriptWordCommands();
  registerChapterCommands();
}
