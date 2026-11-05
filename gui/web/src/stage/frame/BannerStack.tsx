import { FollowBanner } from "./FollowBanner";
import { GuestAttentionBanner } from "./GuestAttentionBanner";
import { GuestVersionNotice } from "./GuestVersionNotice";
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
      {guestShare ? <GuestVersionNotice /> : null}
      <GuestAttentionBanner host={attentionHost} />
      <JobModelBanner guestShare={guestShare} />
      <HomeScreenHint />
      <FollowBanner />
    </>
  );
}
