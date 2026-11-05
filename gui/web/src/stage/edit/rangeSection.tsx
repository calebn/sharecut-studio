import type { InspectorSection } from "../../system/InspectorSheet";
import { RangeFields } from "../../timeline/RangeFields";

export const rangeSection: InspectorSection = {
  id: "range",
  rows: [{ id: "range", control: <RangeFields sheet /> }],
};

/** A passage of words: its In, Out and Length are the range it names. */
export const passageRangeSection: InspectorSection = {
  id: "range",
  rows: [{ id: "range", control: <RangeFields sheet always /> }],
};
