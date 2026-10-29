import { useRef, useState } from "react";
import { Skeleton } from "../../system/Skeleton";
import { StatusRow } from "../../system/StatusRow";
import { Button, SegmentedControl, ToggleButton } from "../../ui";
import { DeliverSection } from "./DeliverSection";
import { FeedChecks } from "./FeedChecks";
import { FeedListing } from "./FeedListing";
import type { EditControls } from "./FeedValue";
import { readiness, readinessTitle, writeLine, xmlLines } from "./feedLogic";
import type { FeedEdit, FeedView, Fix, PinKey, SourceOwner } from "./feedView";
import { ShowSetup } from "./ShowSetup";

export type FeedHostFix = Exclude<Fix["action"], { kind: "edit" | "show" }>;

type Props = {
  view: FeedView;
  /** The item as the feed file will carry it. */
  itemXml: string;
  state?: "ready" | "loading";
  onEdit: (edit: FeedEdit) => void;
  onCreateShow: (title: string) => void;
  /** A fix only the host can run: export, pick art, or open the stage that owns the fact. */
  onFix: (action: FeedHostFix) => void;
  onOpenSource: (owner: SourceOwner) => void;
  onCopyNotes: () => void;
  onCopyItem: () => void;
  onWrite: () => void;
};

type Pane = "listing" | "xml";

/**
 * The episode as a podcast app will show it, with the feed file behind it.
 * Values are read first; a click edits one in place.
 */
export function FeedSection({
  view,
  itemXml,
  state = "ready",
  onEdit,
  onCreateShow,
  onFix,
  onOpenSource,
  onCopyNotes,
  onCopyItem,
  onWrite,
}: Props) {
  const [pane, setPane] = useState<Pane>("listing");
  const [editing, setEditing] = useState<PinKey | null>(null);
  const showName = useRef<HTMLInputElement>(null);
  if (state === "loading") {
    return (
      <DeliverSection title="Podcast listing">
        <Skeleton layout="list" rows={4} />
      </DeliverSection>
    );
  }
  const edit: EditControls = {
    active: editing,
    begin: setEditing,
    end: () => setEditing(null),
  };
  const runFix = (fix: Fix) => {
    const { action } = fix;
    if (action.kind === "edit") setEditing(action.key);
    else if (action.kind === "show") showName.current?.focus();
    else onFix(action);
  };
  const ready = readiness(view.findings);
  const file = writeLine(view);
  const first = ready.kind === "open" ? ready.first : null;
  return (
    <DeliverSection
      title="Podcast listing"
      action={
        <SegmentedControl label="View">
          <ToggleButton
            quiet
            pressed={pane === "listing"}
            onClick={() => setPane("listing")}
          >
            Listing
          </ToggleButton>
          <ToggleButton
            quiet
            pressed={pane === "xml"}
            onClick={() => setPane("xml")}
          >
            XML
          </ToggleButton>
        </SegmentedControl>
      }
    >
      <div className="fd">
        <StatusRow
          state={ready.kind === "ready" ? "done" : "needs-you"}
          title={readinessTitle(ready)}
          detail={first?.message}
          action={
            first?.fix
              ? {
                  label: first.fix.label,
                  onAction: () => runFix(first.fix as Fix),
                }
              : undefined
          }
        />
        {view.show.kind === "none" ? (
          <ShowSetup
            suggest={view.show.suggest}
            inputRef={showName}
            onCreate={onCreateShow}
          />
        ) : null}
        {pane === "listing" ? (
          <FeedListing
            view={view}
            edit={edit}
            onEdit={onEdit}
            onFix={runFix}
            onOpenSource={onOpenSource}
          />
        ) : (
          <pre className="fd-xml" tabIndex={0} aria-label="Item XML">
            <code>
              {xmlLines(itemXml).map((line) => (
                <span key={line.id} className="fd-xml-line">
                  {line.segments.map((segment) => (
                    <span
                      key={segment.id}
                      className={segment.tag ? "fd-xml-tag" : undefined}
                    >
                      {segment.text}
                    </span>
                  ))}
                </span>
              ))}
            </code>
          </pre>
        )}
        <FeedChecks findings={view.findings} onFix={runFix} />
        <div className="fd-foot">
          <p className="fd-file-status">{file.status}</p>
          <div className="fd-actions">
            <Button onClick={onCopyNotes}>Copy notes</Button>
            <Button disabledReason={file.blockedReason} onClick={onCopyItem}>
              Copy item
            </Button>
            {file.action ? (
              <Button
                variant="primary"
                disabledReason={file.blockedReason}
                onClick={onWrite}
              >
                {file.action}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </DeliverSection>
  );
}
