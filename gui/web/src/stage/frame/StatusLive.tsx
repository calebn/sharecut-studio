import { useJobStatusAnnouncement } from "../../hooks/useJobStatusAnnouncement";
import { useDaw } from "../../state/useDaw";
import { StatusLiveRegion } from "../../ui/StatusLiveRegion";
import { useLateWordFailure } from "./useLateWordFailure";

/** The frame's single polite live region, with the job announcements and the late word failures that feed it. */
export function StatusLive() {
  const { message, seq } = useDaw((s) => ({
    message: s.statusAnnouncement,
    seq: s.statusAnnouncementSeq,
  }));
  useJobStatusAnnouncement();
  useLateWordFailure();
  return <StatusLiveRegion message={message} seq={seq} />;
}
