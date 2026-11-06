import {
  LISTEN_CHOICES,
  type ShareOptions,
  shareRowsOf,
} from "../../../stages/deliver/shareLogic";
import { LinkRow } from "../../../system/LinkRow";
import { copyReasonOf, needsMixFor } from "./inviteLogic";
import { MadeLinkRow } from "./ReviewLinks";
import { useShareEnd } from "./useShareEnd";

export const LISTEN_PIN_REASON =
  "The listen link is pinned to the version current when you copy it.";

/**
 * The listen link: a Viewer link frozen on the version current when first copied. A ready row
 * until it is made; the first Copy makes it. Shared by the Invite sheet and
 * Deliver, which embeds it in place.
 */
export function ListenLinkRow({
  options,
  highlight = false,
  share = false,
  compact = false,
  escapeKeeps = true,
}: {
  options: ShareOptions;
  /** Outlines Copy as the follow-up to an export. */
  highlight?: boolean;
  /** Phone: labels Copy as Share. It does not open the system share sheet. */
  share?: boolean;
  compact?: boolean;
  /** False inside the Invite sheet, whose dialog already keeps an open confirm on Escape. */
  escapeKeeps?: boolean;
}) {
  const end = useShareEnd(options, escapeKeeps);
  const { listen } = shareRowsOf(options.rows);
  if (listen) {
    return (
      <MadeLinkRow
        row={listen}
        options={options}
        pending={end.pending}
        onAsk={end.ask}
        onKeep={end.keep}
        onConfirm={() => void end.confirm()}
        highlight={highlight}
        share={share}
        compact={compact}
        pinnedReason={LISTEN_PIN_REASON}
        linkName="listen link"
      />
    );
  }
  const noMix = needsMixFor(options, { listen: true });
  return (
    <LinkRow
      access="viewer"
      link={null}
      linkName="listen link"
      note="Pinned to the version current when you copy it"
      pin={{ pressed: true, disabledReason: LISTEN_PIN_REASON }}
      noMix={noMix ? { onRefresh: options.onRefreshMix } : undefined}
      highlight={highlight}
      share={share}
      compact={compact}
      disabledReason={copyReasonOf(options)}
      onCopy={() => options.onCreate(LISTEN_CHOICES)}
    />
  );
}
