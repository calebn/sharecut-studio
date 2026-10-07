/** Stable entry point for the DAW command registry. Keep registration order here. */
import { registerChapterCommands } from "./chapters";
import { registerCommentCommands } from "./comments";
import { registerCutSpeechCommands } from "./cutSpeech";
import {
  registerClipboardCommands,
  registerClipMoveCommands,
  registerPrimaryEditingCommands,
} from "./editing";
import { registerEnvelopeCommands } from "./envelopes";
import { registerHistoryCommands } from "./history";
import { registerHostCommands } from "./host";
import { registerNavigationCommands } from "./navigation";
import { registerProjectMediaCommands } from "./projectMedia";
import { registerRangeCommands } from "./rangeActions";
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
export { _resetProjectOpenInFlightForTests } from "./projectMedia";
export { _resetSingleFlightsForTests } from "./singleFlight";
export { _resetTrackMutateChainForTests } from "./trackMutation";

export function registerDawCommands(): void {
  registerRangeCommands();
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
  registerCutSpeechCommands();
  registerTightenCommands();
  registerTrackMixCommands();
  registerTranscriptIgnoreCommands();
  registerTranscriptReviewCommands();
  registerTranscriptWordCommands();
  registerChapterCommands();
  registerEnvelopeCommands();
  registerCommentCommands();
}
