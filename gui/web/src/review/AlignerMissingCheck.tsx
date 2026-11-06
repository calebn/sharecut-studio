import { ModelNeedRow, type NeedTarget } from "../models";

const ALIGNER_CHECK_TITLE =
  "Cuts may clip word edges until word timing is installed";

export function AlignerMissingCheck({ model }: { model: NeedTarget }) {
  return (
    <div className="rv-check">
      <ModelNeedRow model={model} idleTitle={ALIGNER_CHECK_TITLE} />
    </div>
  );
}
