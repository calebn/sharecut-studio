import { FrameAlerts } from "./FrameAlerts";
import { JobModelBanner } from "./JobModelBanner";
import { OfflineAttentionAnnouncer } from "./OfflineAttentionAnnouncer";

/** The notices under the header, in one fixed order. */
export function BannerStack({ guestShare = false }: { guestShare?: boolean }) {
  return (
    <FrameAlerts>
      <OfflineAttentionAnnouncer />
      <JobModelBanner guestShare={guestShare} />
    </FrameAlerts>
  );
}
