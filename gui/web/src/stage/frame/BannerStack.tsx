import { FEATURE_SHARE_UI_BANNER } from "../../extensions/features";
import { Slot } from "../../extensions/Slot";
import { guestShareBannerLabel } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import { GuestAttentionBanner } from "./GuestAttentionBanner";
import { GuestVersionNotice } from "./GuestVersionNotice";
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
  const guestMode = useDaw((s) => s.guestMode);
  // The offline fallback opens a cached project with no capabilities from the host.
  const savedCopy = useDaw((s) => guestShare && s.shareCapabilities === null);
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
      {savedCopy ? <SavedCopyNotice /> : null}
      {guestShare ? <GuestVersionNotice /> : null}
      <GuestAttentionBanner host={attentionHost} />
      <JobModelBanner guestShare={guestShare} />
      <HomeScreenHint />
    </>
  );
}
