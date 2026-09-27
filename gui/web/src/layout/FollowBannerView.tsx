import type { CSSProperties } from "react";
import { presenceColorVar } from "../presence/colors";
import {
  type FollowDegraded,
  followBannerDetail,
} from "../presence/followSync";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { tabLabel } from "./tabLabels";

export interface FollowBannerViewProps {
  /** Display name of the client being followed. */
  name: string;
  /** Presence color slot for the avatar and `--presence-color`. */
  colorIndex?: number;
  /** Session role for the avatar's icon (e.g. `"agent"`). */
  sessionRole?: string;
  /** Whether the local viewer is a guest (gates the "Listening in Mix" hint). */
  guest: boolean;
  /** Degraded-follow state (host-only tab, audition mode) to describe. */
  degraded: FollowDegraded;
  onStopFollowing: () => void;
}

/** Props-only follow-banner rendering for live state and static catalog cases. */
export function FollowBannerView({
  name,
  colorIndex,
  sessionRole,
  guest,
  degraded,
  onStopFollowing,
}: FollowBannerViewProps) {
  const guestMix = guest && degraded.audition ? " · Listening in Mix" : "";
  const detail = followBannerDetail(degraded, tabLabel);
  return (
    <div
      className="follow-banner"
      role="status"
      style={
        { "--presence-color": presenceColorVar(colorIndex) } as CSSProperties
      }
    >
      <span aria-hidden>
        <Avatar
          name={name}
          colorIndex={colorIndex}
          sessionRole={sessionRole}
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
        onClick={onStopFollowing}
      >
        Stop following
      </Button>
    </div>
  );
}
