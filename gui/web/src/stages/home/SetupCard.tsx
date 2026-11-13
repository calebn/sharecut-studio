import { useEffect, useRef, useState } from "react";
import { useAfter } from "../../hooks/useAfter";
import { NOT_ON_THIS_DEVICE } from "../../models";
import { Card } from "../../system/Card";
import { StatusRow } from "../../system/StatusRow";
import { SystemIcon } from "../../system/SystemIcon";
import { Button, Menu, MenuItem } from "../../ui";

export type SetupState =
  | "checking"
  | "needed"
  | "downloading"
  | "failed"
  | "check-error"
  | "tools-missing"
  /** This device cannot have audio tools; `detail` is the server's sentence and nothing is offered. */
  | "tools-unsupported";

export type SetupCardProps = {
  state: SetupState;
  /** 0 to 1 while downloading. */
  progress?: number;
  /** "1.1 of 2.0 GB · about 3 min", formatted by the caller. */
  detail?: string;
  /** The download size in words: "about 2 GB". */
  sizeLabel: string;
  onGetReady: () => void;
  onChoose: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onNotNow: () => void;
};

const TITLE = "Get ShareCut ready";
const TOOLS_GUIDE =
  "https://github.com/calebn/sharecut-studio/blob/main/docs/setup.md#acquire-the-pinned-ffmpeg-pair";

/** The first status read has not come back: nothing for 300 ms, then static grey blocks. */
const CHECKING_BLANK_MS = 300;
/** A status read this late is a failed check: say so and offer Try again. */
const CHECKING_GIVE_UP_MS = 8000;

function CheckFailedCard({ onRetry }: Pick<SetupCardProps, "onRetry">) {
  return (
    <Card title={TITLE}>
      <StatusRow
        state="failed"
        title="Couldn't check what's installed."
        action={{ label: "Try again", onAction: onRetry }}
      />
    </Card>
  );
}

function CheckingSkeleton({ onRetry }: Pick<SetupCardProps, "onRetry">) {
  const shown = useAfter(CHECKING_BLANK_MS);
  const gaveUp = useAfter(CHECKING_GIVE_UP_MS);
  if (gaveUp) return <CheckFailedCard onRetry={onRetry} />;
  return (
    <div className="sys-setup-checking">
      {shown ? (
        <>
          <p className="sr-only" role="status">
            Reading the setup status
          </p>
          <div className="sys-card" aria-hidden="true">
            <span className="sys-skeleton-block sys-setup-skeleton-title" />
            <span className="sys-skeleton-block sys-setup-skeleton-line" />
          </div>
        </>
      ) : null}
    </div>
  );
}

function NotNowMenu({ onNotNow }: Pick<SetupCardProps, "onNotNow">) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label="Setup options"
      className="ui-menu-root sys-menu sys-setup-menu"
      trigger={(props) => (
        <button
          type="button"
          className="sys-icon-btn"
          aria-label="More about setup"
          title="More"
          {...props}
        >
          <SystemIcon name="ellipsis" size={16} />
        </button>
      )}
    >
      <MenuItem
        onSelect={() => {
          setOpen(false);
          onNotNow();
        }}
      >
        Not now
      </MenuItem>
    </Menu>
  );
}

/**
 * The Setup card on Home: one download that makes transcription work. Needed
 * offers Get ready and Choose…; the other states are one StatusRow. Missing audio
 * tools offer no download: they say to reinstall and link the setup guide. Raw
 * error text never shows: the caller logs it for the Help diagnostics bundle.
 */
function SetupBody({
  state,
  progress,
  detail,
  sizeLabel,
  onGetReady,
  onChoose,
  onCancel,
  onRetry,
  onNotNow,
}: SetupCardProps) {
  if (state === "checking") return <CheckingSkeleton onRetry={onRetry} />;
  if (state === "needed") {
    return (
      <Card title={TITLE}>
        <div className="sys-setup-needed">
          <span className="sys-setup-icon" aria-hidden="true">
            <SystemIcon name="cloud-download" size={32} />
          </span>
          <p className="sys-setup-line">
            Transcription and cut-finding run on this computer. One download,{" "}
            {sizeLabel}.
          </p>
        </div>
        <div className="sys-setup-actions">
          <Button variant="primary" onClick={onGetReady}>
            Get ready
          </Button>
          <button type="button" className="sys-text-btn" onClick={onChoose}>
            Choose…
          </button>
          <span className="sys-setup-more">
            <NotNowMenu onNotNow={onNotNow} />
          </span>
        </div>
      </Card>
    );
  }
  if (state === "downloading") {
    return (
      <Card title="Getting ShareCut ready">
        <div className="sys-setup-job">
          <StatusRow
            state="running"
            title="Downloading"
            detail={detail}
            progress={progress}
          />
          <button
            type="button"
            className="sys-icon-btn sys-setup-cancel"
            aria-label="Cancel the download"
            title="Cancel"
            onClick={onCancel}
          >
            <SystemIcon name="x" size={16} />
          </button>
        </div>
      </Card>
    );
  }
  if (state === "tools-missing") {
    return (
      <Card title={TITLE}>
        <StatusRow
          state="needs-you"
          title="Audio tools are missing."
          detail="Reinstall ShareCut Studio to restore them."
          action={{ label: "Check again", onAction: onRetry }}
        />
        <p className="sys-setup-line">
          <a
            className="sys-text-btn"
            href={TOOLS_GUIDE}
            target="_blank"
            rel="noreferrer"
          >
            Setup guide for the audio tools
          </a>
        </p>
      </Card>
    );
  }
  if (state === "tools-unsupported") {
    return (
      <Card title="Audio tools">
        <StatusRow state="queued" title={detail ?? NOT_ON_THIS_DEVICE} />
      </Card>
    );
  }
  if (state === "check-error") return <CheckFailedCard onRetry={onRetry} />;
  return (
    <Card title={TITLE}>
      <StatusRow
        state="failed"
        title="The download didn't finish."
        action={{ label: "Try again", onAction: onRetry }}
      />
    </Card>
  );
}

/** A card that changes later for another reason is not the Cancel the person pressed. */
const CANCEL_FOCUS_MS = 5000;

function focusAfterCancel(root: HTMLElement) {
  const next =
    root.querySelector<HTMLElement>(".sys-setup-actions button") ??
    root.querySelector<HTMLElement>("h1, h2, h3, h4, [role='heading']");
  if (next) {
    if (!next.matches("button")) next.tabIndex = -1;
    next.focus();
  }
}

export function SetupCard(props: SetupCardProps) {
  const root = useRef<HTMLDivElement>(null);
  const cancelledAt = useRef<number | null>(null);
  const { state, onCancel } = props;
  useEffect(() => {
    const at = cancelledAt.current;
    if (at === null || state === "downloading") return;
    cancelledAt.current = null;
    if (Date.now() - at < CANCEL_FOCUS_MS && root.current) {
      focusAfterCancel(root.current);
    }
  }, [state]);
  return (
    <div className="sys-setup" ref={root}>
      <SetupBody
        {...props}
        onCancel={() => {
          cancelledAt.current = Date.now();
          onCancel();
        }}
      />
    </div>
  );
}
