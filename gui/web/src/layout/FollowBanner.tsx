import { execute } from "../commands/execute";
import { rosterDisplayName } from "../presence/colors";
import { useDawStore } from "../state/dawStore";
import { FollowBannerView } from "./FollowBannerView";

export function FollowBanner() {
  const followingClientId = useDawStore((s) => s.followingClientId);
  const sessionClients = useDawStore((s) => s.sessionClients);
  const guestMode = useDawStore((s) => s.guestMode);
  const followDegraded = useDawStore((s) => s.followDegraded);
  if (!followingClientId) {
    return null;
  }
  const target = sessionClients[followingClientId];
  return (
    <FollowBannerView
      name={target ? rosterDisplayName(target) : followingClientId}
      colorIndex={target?.meta?.color_index}
      sessionRole={target?.role}
      guest={guestMode != null}
      degraded={followDegraded}
      onStopFollowing={() => {
        void execute("presence.unfollow");
      }}
    />
  );
}
