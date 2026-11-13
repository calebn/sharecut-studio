import {
  type ComposerEvent,
  composerPatch,
  reduceComposer,
} from "../state/composerSession";
import { useDawStore } from "../state/dawStore";
import { runPointerCommand } from "./pointer";

/**
 * The one way to change the composer session: reduces the event against the
 * live transport, stores the result, then does what the reducer asked of the
 * transport (pause for the comment, play on after it).
 */
export function dispatchComposer(event: ComposerEvent): void {
  const { composer, isPlaying } = useDawStore.getState();
  const { state, effects } = reduceComposer(composer, event, {
    playing: isPlaying,
  });
  if (state !== composer) useDawStore.setState(composerPatch(state));
  for (const _ of effects) runPointerCommand("transport.togglePlay");
}
