import { useJobStatusAnnouncement } from "../../hooks/useJobStatusAnnouncement";
import { useDaw } from "../../state/useDaw";
import { StatusLiveRegion } from "../../ui/StatusLiveRegion";

/** The frame's single polite live region, with the job announcements that feed it. */
export function StatusLive() {
  const { message, seq } = useDaw((s) => ({
    message: s.statusAnnouncement,
    seq: s.statusAnnouncementSeq,
  }));
  useJobStatusAnnouncement();
  return <StatusLiveRegion message={message} seq={seq} />;
}
