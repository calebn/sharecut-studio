import { CoverScreen } from "../ui/CoverScreen";
import { DECLINED_COPY } from "./types";

export function Declined() {
  return (
    <CoverScreen
      heading="You declined"
      shellClassName="review-shell record-shell"
    >
      <p>{DECLINED_COPY}</p>
    </CoverScreen>
  );
}
