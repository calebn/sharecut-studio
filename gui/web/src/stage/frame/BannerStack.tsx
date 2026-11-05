import { HomeScreenHint } from "./HomeScreenHint";
import { JobModelBanner } from "./JobModelBanner";
import { OfflineAttentionAnnouncer } from "./OfflineAttentionAnnouncer";

/** The notices under the header, in one fixed order. */
export function BannerStack({ guestShare = false }: { guestShare?: boolean }) {
  return (
    <>
      <OfflineAttentionAnnouncer />
      <JobModelBanner guestShare={guestShare} />
      <HomeScreenHint />
    </>
  );
}
