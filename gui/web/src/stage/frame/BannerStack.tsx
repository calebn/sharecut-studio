import { FEATURE_SHARE_UI_BANNER } from "../../extensions/features";
import { Slot } from "../../extensions/Slot";
import { guestShareBannerLabel } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import { FollowBanner } from "./FollowBanner";
import { GuestAttentionBanner } from "./GuestAttentionBanner";
import { GuestVersionNotice } from "./GuestVersionNotice";
import { HomeScreenHint } from "./HomeScreenHint";
import { JobModelBanner } from "./JobModelBanner";
import { type LoadFailure, LoadFailureBanner } from "./LoadFailureBanner";

/** The notices under the header, in the order the old shell stacked them. */
export function BannerStack({
  guestShare = false,
  attentionHost,
  loadFailure,
}: {
  guestShare?: boolean;
  attentionHost?: HTMLElement | null;
  loadFailure?: LoadFailure | null;
}) {
  const guestMode = useDaw((s) => s.guestMode);
  return (
    <>
      <LoadFailureBanner failure={loadFailure} />
      <Slot id={FEATURE_SHARE_UI_BANNER}>
        {guestShare ? (
          <div className="guest-banner" role="status">
            {guestShareBannerLabel(guestMode)}
          </div>
        ) : null}
      </Slot>
      {guestShare ? <GuestVersionNotice /> : null}
      <GuestAttentionBanner host={attentionHost} />
      <JobModelBanner guestShare={guestShare} />
      <HomeScreenHint />
      <FollowBanner />
    </>
  );
}
