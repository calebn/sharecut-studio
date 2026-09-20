import { Button } from "../ui";
import { CONSENT_COPY } from "./types";

type Props = {
  onAccept: () => void;
  onDecline: () => void;
  canAccept?: boolean;
  acceptDescribedBy?: string;
};

export function ConsentGate({
  onAccept,
  onDecline,
  canAccept = true,
  acceptDescribedBy,
}: Props) {
  return (
    <section className="stack" aria-labelledby="consent-heading">
      <h2 id="consent-heading">Recording consent</h2>
      <p>{CONSENT_COPY}</p>
      <div className="cluster">
        <Button
          variant="primary"
          type="button"
          disabled={!canAccept}
          aria-describedby={!canAccept ? acceptDescribedBy : undefined}
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
