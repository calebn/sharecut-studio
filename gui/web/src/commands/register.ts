/** Stable entry point for the DAW command registry. Keep registration order here. */
import { registerChapterCommands } from "./chapters";
import { registerClipBleedCommands } from "./clipBleed";
import { registerCommentCommands } from "./comments";
import {
  registerClipboardCommands,
  registerClipMoveCommands,
  registerPrimaryEditingCommands,
} from "./editing";
import { registerEditVerbCommands } from "./editVerbs";
import { registerEnvelopeCommands } from "./envelopes";
import { registerHistoryCommands } from "./history";
import { registerHostCommands } from "./host";
import { registerNavigationCommands } from "./navigation";
import { registerProjectMediaCommands } from "./projectMedia";
import { registerRangeCommands } from "./rangeActions";
import { registerSpeakerMoveLaneSpanCommands } from "./speakerMoveLaneSpan";
import { registerSpeakerSplitCommands } from "./speakerSplit";
import { registerTrackMixCommands } from "./trackMix";
import { registerTranscriptIgnoreCommands } from "./transcriptIgnore";
import { registerTranscriptRangeCommands } from "./transcriptRange";
import { registerTranscriptWordCommands } from "./transcriptWord";
import {
  registerPaletteCommands,
  registerTranscriptViewCommands,
  registerViewCommands,
} from "./view";

export { _resetProjectOpenInFlightForTests } from "./projectMedia";
export { _resetSingleFlightsForTests } from "./singleFlight";
export { _resetTrackMutateChainForTests } from "./trackMutation";

export function registerDawCommands(): void {
  registerClipBleedCommands();
  registerRangeCommands();
  registerSpeakerMoveLaneSpanCommands();
  registerNavigationCommands();
  registerPrimaryEditingCommands();
  registerEditVerbCommands();
  registerViewCommands();
  registerHistoryCommands();
  registerClipboardCommands();
  registerPaletteCommands();
  registerHostCommands();
  registerProjectMediaCommands();
  registerSpeakerSplitCommands();
  registerTranscriptViewCommands();
  registerClipMoveCommands();
  registerTrackMixCommands();
  registerTranscriptIgnoreCommands();
  registerTranscriptRangeCommands();
  registerTranscriptWordCommands();
  registerChapterCommands();
  registerEnvelopeCommands();
  registerCommentCommands();
}
