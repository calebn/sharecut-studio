import { ModelNeedRow, type NeedTarget } from "../models";

export const ALIGNER_CHECK_TITLE =
  "Cuts may clip word edges until word timing is installed";

/**
 * The Check row for a transcript timed without the word aligner: one Model need row with Get, and
 * with progress, Cancel and Try again as the download goes. The queue shows it only while such a
 * transcript exists and the aligner is not in.
 */
export function AlignerMissingCheck({ model }: { model: NeedTarget }) {
  return (
    <div className="rv-check">
      <ModelNeedRow model={model} idleTitle={ALIGNER_CHECK_TITLE} />
    </div>
  );
}
