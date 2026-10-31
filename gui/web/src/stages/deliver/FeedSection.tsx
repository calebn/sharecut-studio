import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDawStore } from "../../state/dawStore";
import { Cover } from "../../system/Cover";
import { Skeleton } from "../../system/Skeleton";
import { StatusGlyph } from "../../system/StatusGlyph";
import { StatusRow } from "../../system/StatusRow";
import type {
  FeedEdit,
  FeedView,
  FieldKey,
  Fix,
  WriteRequest,
} from "../../types/feedView";
import {
  Button,
  SegmentedControl,
  Toast,
  type ToastState,
  ToggleButton,
} from "../../ui";
import { useDisabledReasonNote } from "../../ui/disabledReason";
import { DeliverSection } from "./DeliverSection";
import type { FileListProps } from "./deliverFiles";
import { ExportedFiles } from "./ExportedFiles";
import { FeedAsk } from "./FeedAsk";
import { FeedChecks } from "./FeedChecks";
import { FeedListing } from "./FeedListing";
import type { EditControls, OnEdit } from "./FeedValue";
import {
  checksSummary,
  type FeedAccess,
  FILE_LINE_STATE,
  fixBlock,
  fixLabel,
  KEY,
  needsInput,
  PIN_FIELDS,
  READ_ONLY_WHY,
  readiness,
  readinessTitle,
  readinessTone,
  type SourceOwner,
  writeLine,
  xmlLines,
} from "./feedLogic";
import { ShowHostNote, ShowSetup } from "./ShowSetup";

type Props = {
  view: FeedView;
  /** The item as the feed file will carry it. */
  itemXml: string;
  state?: "ready" | "loading" | "error";
  /** Who is looking. A link that is not the host's leaves the show and its files to the host, and a Viewer or Commenter link only reads. */
  access?: FeedAccess;
  /** The last thing that went wrong, in plain words. With `state` error it is why the listing did not load. */
  problem?: string | null;
  onRetry?: () => void;
  onDismissProblem?: () => void;
  /** A write this surface has sent and not heard back from, or one that failed. The service's own file state is none, current or stale. */
  request?: WriteRequest;
  /** Every edit and command the section can start, in the vocabulary the CLI and MCP share. */
  onAction: (fix: Fix) => void;
  /** Opens the stage that owns a fact the listing reads but never edits. */
  onOpenSource: (owner: SourceOwner) => void;
  /** The feed file's row, when the export folder holds one. */
  files?: FileListProps;
};

type Pane = "listing" | "xml";

const editFix = (edit: FeedEdit): Fix => ({ kind: "edit", edit });

/**
 * The episode as a podcast app will show it, with the feed file behind it.
 * Values are read first; a click edits one in place.
 */
export function FeedSection({
  view,
  itemXml,
  state = "ready",
  access = "host",
  problem,
  onRetry,
  onDismissProblem,
  request,
  onAction,
  onOpenSource,
  files,
}: Props) {
  const [pane, setPane] = useState<Pane>("listing");
  const [editing, setEditing] = useState<FieldKey | null>(null);
  const [asking, setAsking] = useState<FieldKey | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [undo, setUndo] = useState<(() => void) | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const file = writeLine(view, request);
  const reason = useDisabledReasonNote(file.blockedReason);
  const refocus = useRef<string | null>(null);
  const back = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    back.current = el.querySelector<HTMLElement>(".fd-notes .fd-value");
    const want = refocus.current;
    if (want === null) return;
    const target =
      want === "undo"
        ? [...el.querySelectorAll<HTMLElement>(".ui-toast button")].find(
            (button) => button.textContent === "Undo",
          )
        : el.querySelector<HTMLElement>(`[data-field="${want}"] .fd-value`);
    if (!target) return;
    refocus.current = null;
    target.focus();
  });
  const wasRequest = useRef(request);
  useEffect(() => {
    const was = wasRequest.current;
    wasRequest.current = request;
    if (was !== "writing" || request !== undefined || view.file !== "current")
      return;
    const message = "Wrote the feed file.";
    setToast({ id: Date.now(), message });
    setUndo(null);
    useDawStore.getState().announceStatus(message, { toast: false });
  }, [request, view.file]);
  if (state === "error") {
    return (
      <DeliverSection title="Podcast listing">
        <Cover
          size="region"
          glyph="octagon-alert"
          title="Could not load the listing"
          primary={
            onRetry ? { label: "Try again", onClick: onRetry } : undefined
          }
        >
          {problem ?? "Something went wrong. Try again."}
        </Cover>
      </DeliverSection>
    );
  }
  if (state === "loading") {
    return (
      <DeliverSection title="Podcast listing">
        <div className="fd-loading">
          <p className="fd-loading-text" role="status">
            Loading the listing
          </p>
          <Skeleton layout="list" rows={4} blankMs={0} />
        </div>
      </DeliverSection>
    );
  }
  const notify = (message: string, onUndo?: () => void) => {
    setToast({ id: Date.now(), message });
    setUndo(
      onUndo
        ? () => () => {
            onUndo();
            setToast(null);
          }
        : null,
    );
    useDawStore.getState().announceStatus(message, { toast: false });
  };
  const onEdit: OnEdit = (change, undoWith) => {
    const fromDrift = editing === null;
    onAction(editFix(change));
    if (fromDrift) refocus.current = undoWith ? "undo" : change.key;
    if (undoWith)
      notify(undoWith.message, () => {
        onAction(
          undoWith.by
            ? { kind: "edit", edit: undoWith.edit, by: undoWith.by }
            : editFix(undoWith.edit),
        );
        refocus.current = undoWith.edit.key;
      });
  };
  const edit: EditControls = {
    active: editing,
    begin: setEditing,
    end: () => setEditing(null),
    locked: access === "viewer",
  };
  const focusIn = (selector: string) =>
    root.current?.querySelector<HTMLElement>(selector)?.focus();
  const runFix = (fix: Fix) => {
    if (fixBlock(access, fix)) return;
    const key = needsInput(fix);
    if (key !== null) {
      if (PIN_FIELDS[key]) setEditing(key);
      else setAsking(key);
    } else if (
      fix.kind === "command" &&
      (fix.command === "create_show" || fix.command === "link_show")
    )
      focusIn(".fd-setup input, .fd-setup button");
    else onAction(fix);
  };
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(`Copied ${what}`);
    } catch {
      useDawStore
        .getState()
        .announceStatus(`Could not copy ${what}. Select it and copy by hand.`, {
          tone: "error",
        });
    }
  };
  const ready = readiness(view);
  const tone = readinessTone(ready);
  const first = ready.kind === "ready" ? null : ready.first;
  const firstFix = first?.fix ?? null;
  const action =
    access === "viewer"
      ? undefined
      : ready.kind === "check"
        ? // Only the notes show Keep mine and Use new in place; other values have nowhere to review.
          ready.first.key === KEY.notes
          ? { label: "Review", onAction: () => focusIn("[data-drift] button") }
          : undefined
        : firstFix && !fixBlock(access, firstFix)
          ? { label: fixLabel(firstFix), onAction: () => runFix(firstFix) }
          : undefined;
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
      <div className="fd" ref={root}>
        <div className="fd-strip" data-tone={tone}>
          <StatusRow
            state={ready.kind === "ready" ? "done" : "needs-you"}
            title={readinessTitle(ready)}
            detail={first?.message}
            action={action}
          />
        </div>
        {access === "host" ? null : (
          <p className="fd-access">
            {access === "editor"
              ? "You can edit this listing. The show and the hosting template stay with the host."
              : READ_ONLY_WHY}
          </p>
        )}
        {problem ? (
          <div className="fd-problem" role="alert">
            <StatusRow
              density="alert"
              state="failed"
              title="That did not go through"
              detail={problem}
              action={
                onDismissProblem
                  ? { label: "Dismiss", onAction: onDismissProblem }
                  : undefined
              }
            />
          </div>
        ) : null}
        {view.show.kind === "ready" ? null : access === "host" ? (
          <ShowSetup show={view.show} onAction={onAction} />
        ) : (
          <ShowHostNote show={view.show} />
        )}
        {asking === null ? null : (
          <FeedAsk
            field={asking}
            access={access}
            onSave={(change) => {
              onAction(editFix(change));
              setAsking(null);
            }}
            onCancel={() => setAsking(null)}
          />
        )}
        {pane === "listing" ? (
          <FeedListing
            view={view}
            edit={edit}
            onEdit={onEdit}
            onOpenSource={onOpenSource}
          />
        ) : (
          <pre
            className="fd-xml"
            role="region"
            // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the block scrolls sideways, so it needs a keyboard stop
            tabIndex={0}
            aria-label="Item XML"
          >
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
        <FeedChecks
          findings={view.findings}
          summary={checksSummary(view)}
          onFix={runFix}
          blockOf={(fix) => fixBlock(access, fix)}
          readOnly={access === "viewer"}
        />
        <div className="fd-foot">
          <p className="fd-file-status">
            <StatusGlyph state={FILE_LINE_STATE[request ?? view.file]} colon />
            {file.status}
            {file.writing ? (
              <span className="fd-writing" aria-hidden="true" />
            ) : null}
          </p>
          <div className="fd-actions">
            <Button onClick={() => void copy(view.notesHtml, "notes")}>
              Copy notes
            </Button>
            <Button
              disabledReason={file.blockedReason}
              {...reason.describedBy}
              onClick={() => void copy(itemXml, "feed item")}
            >
              Copy feed item
            </Button>
            {file.action && access !== "viewer" ? (
              <Button
                variant={
                  file.blockedReason || request === "failed"
                    ? "default"
                    : "primary"
                }
                disabledReason={file.blockedReason}
                {...reason.describedBy}
                onClick={() =>
                  onAction({ kind: "command", command: "write_feed" })
                }
              >
                {file.action}
              </Button>
            ) : null}
          </div>
          {reason.note}
        </div>
        {files ? <ExportedFiles {...files} /> : null}
        <Toast
          className="sys-toast-dock"
          toast={toast}
          onUndo={undo ?? undefined}
          returnFocusRef={back}
          onDismiss={() => setToast(null)}
        />
      </div>
    </DeliverSection>
  );
}
