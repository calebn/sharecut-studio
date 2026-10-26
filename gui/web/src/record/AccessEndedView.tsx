import { Button, CoverScreen } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";
import type { KeeperRecoveryActions } from "./upload/useKeeperRecoveryActions";

export function AccessEndedView({
  inviteClosed,
  captureSettled,
  keeperActions,
}: {
  inviteClosed: boolean;
  captureSettled: boolean;
  keeperActions: KeeperRecoveryActions;
}) {
  return (
    <CoverScreen
      heading={inviteClosed ? "Invite link closed" : "Recording access ended"}
      shellClassName="error-screen record-shell"
    >
      <p className="home-screen-error" role="alert">
        {inviteClosed
          ? "The host closed this invite link to new participants. Ask the host for a new link."
          : "Your access to this recording room has ended."}
      </p>
      {!captureSettled ? <p>Finishing your full-quality recording…</p> : null}
      {captureSettled && keeperActions.recover ? (
        <Button
          onClick={keeperActions.recover}
          disabledReason={keeperActions.busy ? BUSY_REASON : undefined}
        >
          Recover full-quality recording
        </Button>
      ) : null}
      {captureSettled && keeperActions.download ? (
        <Button
          onClick={keeperActions.download}
          disabledReason={keeperActions.busy ? BUSY_REASON : undefined}
        >
          Download full-quality recording
        </Button>
      ) : null}
      {keeperActions.error ? <p role="alert">{keeperActions.error}</p> : null}
      {keeperActions.notice ? (
        <p role="status">{keeperActions.notice}</p>
      ) : null}
    </CoverScreen>
  );
}
