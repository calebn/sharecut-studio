import type { ShownTranscript } from "../../document/shownTranscript";
import type { RememberedSelection } from "../../edit/selectionFollow";
import type { Selection } from "../../types/project";

export * from "../../edit/selectionFollow";

type RememberedGuestSelection = RememberedSelection & {
  stored: NonNullable<Selection>;
  verifiedRows: ShownTranscript["rows"];
};

export class GuestSelectionMemory {
  #selection: RememberedGuestSelection | null = null;

  get() {
    return this.#selection;
  }

  set(selection: RememberedGuestSelection | null) {
    this.#selection = selection;
  }
}
