import type { CSSProperties } from "react";
import { execute } from "../commands/execute";
import { presenceColorVar, rosterDisplayName } from "../presence/colors";
import { followBannerDetail } from "../presence/followSync";
import { useDawStore } from "../state/dawStore";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { tabLabel } from "./tabLabels";

export function FollowBanner() {
  const followingClientId = useDawStore((s) => s.followingClientId);
  const sessionClients = useDawStore((s) => s.sessionClients);
  const guestMode = useDawStore((s) => s.guestMode);
  const followDegraded = useDawStore((s) => s.followDegraded);
  if (!followingClientId) {
    return null;
  }
  const target = sessionClients.find((c) => c.client_id === followingClientId);
  const name = target ? rosterDisplayName(target) : followingClientId;
  const color = presenceColorVar(target?.meta?.color_index);
  const guestMix =
    guestMode != null && followDegraded.audition ? " · Listening in Mix" : "";
  const detail = followBannerDetail(followDegraded, tabLabel);
  return (
    <div
      className="follow-banner"
      role="status"
      style={{ "--presence-color": color } as CSSProperties}
    >
      <span aria-hidden>
        <Avatar
          name={name}
          colorIndex={target?.meta?.color_index}
          sessionRole={target?.role}
          size="sm"
        />
      </span>
      <span className="follow-banner-text">
        Following {name}
        {guestMix}
        {detail}
      </span>
      <Button
        variant="link"
        className="follow-banner-stop"
        onClick={() => {
          void execute("presence.unfollow");
        }}
      >
        Stop following
      </Button>
    </div>
  );
}
