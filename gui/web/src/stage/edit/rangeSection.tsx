import type { InspectorSection } from "../../system/InspectorSheet";
import { RangeFields } from "../../timeline/RangeFields";

export const rangeSection: InspectorSection = {
  id: "range",
  rows: [{ id: "range", control: <RangeFields sheet /> }],
};
