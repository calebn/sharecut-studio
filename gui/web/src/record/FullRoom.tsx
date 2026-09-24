import { CoverScreen } from "../ui/CoverScreen";
import { FULL_ROOM_COPY } from "./types";

export function FullRoom() {
  return (
    <CoverScreen heading="Room full" shellClassName="review-shell record-shell">
      <p>{FULL_ROOM_COPY}</p>
    </CoverScreen>
  );
}
