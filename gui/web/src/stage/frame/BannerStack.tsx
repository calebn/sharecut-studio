import { FrameAlertSlot } from "./FrameAlerts";
import { JobModelBanner } from "./JobModelBanner";
import { OfflineAttentionAnnouncer } from "./OfflineAttentionAnnouncer";

/** The notices under the header, in one fixed order; the alert slot comes first. */
export function BannerStack({ guestShare = false }: { guestShare?: boolean }) {
  return (
    <>
      <FrameAlertSlot />
      <OfflineAttentionAnnouncer />
      <JobModelBanner guestShare={guestShare} />
    </>
  );
}
