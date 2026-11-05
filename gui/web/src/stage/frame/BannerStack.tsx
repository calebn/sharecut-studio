import { HomeScreenHint } from "./HomeScreenHint";
import { JobModelBanner } from "./JobModelBanner";
import { type LoadFailure, LoadFailureBanner } from "./LoadFailureBanner";
import { OfflineAttentionAnnouncer } from "./OfflineAttentionAnnouncer";

/** The notices under the header, in one fixed order. */
export function BannerStack({
  guestShare = false,
  loadFailure,
}: {
  guestShare?: boolean;
  loadFailure?: LoadFailure | null;
}) {
  return (
    <>
      <LoadFailureBanner failure={loadFailure} />
      <OfflineAttentionAnnouncer />
      <JobModelBanner guestShare={guestShare} />
      <HomeScreenHint />
    </>
  );
}
