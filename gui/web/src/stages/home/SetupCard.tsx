import { useState } from "react";
import { Card } from "../../system/Card";
import { StatusRow } from "../../system/StatusRow";
import { SystemIcon } from "../../system/SystemIcon";
import { Button, Menu, MenuItem } from "../../ui";

export type SetupState =
  | "needed"
  | "downloading"
  | "failed"
  | "check-error"
  | "tools-missing";

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
        <StatusRow
          state="running"
          title="Downloading"
          detail={detail}
          progress={progress}
          action={{ label: "Cancel", onAction: onCancel }}
        />
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
          <a href={TOOLS_GUIDE} target="_blank" rel="noreferrer">
            Setup guide for the audio tools
          </a>
        </p>
      </Card>
    );
  }
  const checking = state === "check-error";
  return (
    <Card title={TITLE}>
      <StatusRow
        state="failed"
        title={
          checking
            ? "Couldn't check what's installed."
            : "The download didn't finish."
        }
        action={{ label: "Try again", onAction: onRetry }}
      />
    </Card>
  );
}

export function SetupCard(props: SetupCardProps) {
  return (
    <div className="sys-setup">
      <SetupBody {...props} />
    </div>
  );
}
