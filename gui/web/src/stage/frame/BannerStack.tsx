import { GuestAttentionBanner } from "./GuestAttentionBanner";
import { HomeScreenHint } from "./HomeScreenHint";
import { JobModelBanner } from "./JobModelBanner";
import { type LoadFailure, LoadFailureBanner } from "./LoadFailureBanner";

/** The notices under the header, in one fixed order. */
export function BannerStack({
  guestShare = false,
  attentionHost,
  loadFailure,
}: {
  guestShare?: boolean;
  attentionHost?: HTMLElement | null;
  loadFailure?: LoadFailure | null;
}) {
  return (
    <>
      <LoadFailureBanner failure={loadFailure} />
      <GuestAttentionBanner host={attentionHost} />
      <JobModelBanner guestShare={guestShare} />
      <HomeScreenHint />
    </>
  );
}
