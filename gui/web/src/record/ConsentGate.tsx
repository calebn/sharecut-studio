import { useId } from "react";
import { Button } from "../ui";
import { CONSENT_COPY } from "./types";

type Props = {
  onAccept: () => void;
  onDecline: () => void;
  /** Why Accept is unavailable; undefined when the lobby is ready. */
  acceptDisabledReason?: string;
  acceptDescribedBy?: string;
};

export function ConsentGate({
  onAccept,
  onDecline,
  acceptDisabledReason,
  acceptDescribedBy,
}: Props) {
  const headingId = useId();
  return (
    <section className="stack" aria-labelledby={headingId}>
      <h2 id={headingId}>Recording consent</h2>
      <p>{CONSENT_COPY}</p>
      <div className="cluster">
        <Button
          variant="primary"
          type="button"
          disabledReason={acceptDisabledReason}
          aria-describedby={
            acceptDisabledReason ? acceptDescribedBy : undefined
          }
          onClick={onAccept}
        >
          Accept
        </Button>
        <Button type="button" onClick={onDecline}>
          Decline
        </Button>
      </div>
    </section>
  );
}
