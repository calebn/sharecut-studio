import { useDaw } from "../../state/useDaw";
import { FollowBanner } from "./FollowBanner";
import { GuestAttentionBanner } from "./GuestAttentionBanner";
import { HomeScreenHint } from "./HomeScreenHint";
import { JobModelBanner } from "./JobModelBanner";
import { type LoadFailure, LoadFailureBanner } from "./LoadFailureBanner";
import { SavedCopyNotice } from "./SavedCopyNotice";

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
  // The offline fallback opens a cached project with no capabilities from the host.
  const savedCopy = useDaw((s) => guestShare && s.shareCapabilities === null);
  return (
    <>
      <LoadFailureBanner failure={loadFailure} />
      {savedCopy ? <SavedCopyNotice /> : null}
      <GuestAttentionBanner host={attentionHost} />
      <JobModelBanner guestShare={guestShare} />
      <HomeScreenHint />
      <FollowBanner />
    </>
  );
}
