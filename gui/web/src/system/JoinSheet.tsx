import {
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import { Button, ToggleButton } from "../ui";
import type { DrawerDetent } from "../ui/BottomSheet";
import { BUSY_REASON } from "../ui/disabledReason";
import {
  consentDetails,
  consentLine,
  JOIN_TEXT,
  type JoinMic,
  type JoinMicAction,
  type JoinPrimary,
  type JoinRow,
  type JoinStep,
  joinGuestModel,
  joinHeadline,
  joinProducerModel,
  listenersLine,
} from "./joinSheetModel";
import { PersonAvatar, type PersonData } from "./Person";
import type { RoomRole } from "./roomViewModel";
import { Sheet } from "./Sheet";
import { StatusRow } from "./StatusRow";
import { SystemIcon } from "./SystemIcon";

type JoinHere = { person: PersonData; role: RoomRole };

export type JoinSheetProps = {
  seat: "guest" | "producer";
  /** `phone` is the bottom sheet at its large detent; `desktop` a centred card. */
  viewerWidth?: "desktop" | "phone";
  /** Who is in the room now, the host included. */
  here: JoinHere[];
  host: string;
  name: string;
  onNameChange: (name: string) => void;
  /** Guest only. */
  mic?: JoinMic;
  headphones?: boolean;
  onHeadphonesChange?: (on: boolean) => void;
  lowStorage?: boolean;
  onMicAction?: (action: JoinMicAction) => void;
  joining?: boolean;
  onJoin: () => void;
  /** Not now, Escape and Close all decline. */
  onDecline: () => void;
};

function Row({
  row,
  onMicAction,
  children,
}: {
  row: JoinRow;
  onMicAction?: (action: JoinMicAction) => void;
  children?: ReactNode;
}) {
  const { action } = row;
  return (
    <div className="sys-join-row" data-step={row.key} tabIndex={-1}>
      <StatusRow
        state={row.state}
        title={row.title}
        detail={row.detail}
        action={
          action
            ? {
                label: action.label,
                name: action.name,
                onAction: () => onMicAction?.(action.kind),
              }
            : undefined
        }
      />
      {children ? <div className="sys-join-control">{children}</div> : null}
    </div>
  );
}

function Consent({
  host,
  listeners,
}: {
  host: string;
  listeners: string | null;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  return (
    <div className="sys-join-consent">
      <p className="sys-join-line">{consentLine(host)}</p>
      <button
        type="button"
        className="sys-text-btn"
        aria-expanded={open}
        aria-controls={open ? detailsId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        Details
      </button>
      {open ? (
        <div id={detailsId} className="sys-join-details">
          <p>{consentDetails(host)}</p>
          {listeners ? <p>{listeners}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function Footer({
  primary,
  onJoin,
  onDecline,
}: {
  primary: JoinPrimary;
  onJoin: () => void;
  onDecline: () => void;
}) {
  const reasonId = useId();
  return (
    <div className="sys-join-footer">
      <Button
        variant="primary"
        onClick={onJoin}
        aria-busy={primary.busy || undefined}
        aria-describedby={primary.reason ? reasonId : undefined}
        disabledReason={
          primary.busy ? BUSY_REASON : (primary.reason ?? undefined)
        }
      >
        {primary.busy ? (
          <SystemIcon name="progress-ring" size={16} progress={0.3} />
        ) : null}
        {primary.label}
      </Button>
      <p id={reasonId} className="sys-join-reason">
        {primary.reason}
      </p>
      <Button variant="link" onClick={onDecline}>
        {JOIN_TEXT.decline}
      </Button>
    </div>
  );
}

/**
 * The pre-join sheet over a live room. Rows check themselves off as the
 * caller's state moves; the primary stays disabled and names the first row
 * still to do. Presentational: the caller owns the name, the mic and the
 * join itself. Not now, Escape and Close all decline.
 */
export function JoinSheet({
  seat,
  viewerWidth = "desktop",
  here,
  host,
  name,
  onNameChange,
  mic = { status: "idle" },
  headphones = false,
  onHeadphonesChange,
  lowStorage = false,
  onMicAction,
  joining = false,
  onJoin,
  onDecline,
}: JoinSheetProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [detent, setDetent] = useState<DrawerDetent>("full");
  const phone = viewerWidth === "phone";
  const guest = seat === "guest";
  const guestModel = joinGuestModel({
    name,
    mic,
    headphones,
    lowStorage,
    joining,
  });
  const producerModel = joinProducerModel({ name, joining });
  const { next, ready, primary } = guest ? guestModel : producerModel;

  // Enter on the name moves to the next row (its button, or the row itself
  // while the browser's prompt is up); Enter on a ready sheet joins.
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (joining) return;
    if (ready) {
      onJoin();
      return;
    }
    const target: JoinStep = next ?? "name";
    if (target === "name") nameRef.current?.focus();
    else {
      const row = formRef.current?.querySelector<HTMLElement>(
        `[data-step="${target}"]`,
      );
      (row?.querySelector<HTMLElement>("button") ?? row)?.focus();
    }
  };

  const nameField = (
    <input
      ref={nameRef}
      type="text"
      className="sys-join-input"
      aria-label="Your name"
      autoComplete="name"
      value={name}
      onChange={(event) => onNameChange(event.target.value)}
    />
  );

  return (
    <Sheet
      form={phone ? "bottom" : "centered"}
      title={joinHeadline(here)}
      panelClassName="sys-join-sheet"
      detent={detent}
      onDetentChange={setDetent}
      initialFocusRef={phone ? undefined : nameRef}
      onClose={onDecline}
      footer={
        <Footer primary={primary} onJoin={onJoin} onDecline={onDecline} />
      }
    >
      <form
        ref={formRef}
        className="sys-join"
        data-seat={seat}
        onSubmit={submit}
      >
        {here.length > 0 ? (
          <div className="sys-join-here" aria-hidden="true">
            {here.map((entry) => (
              <PersonAvatar
                key={`${entry.person.name}-${entry.person.colorIndex}`}
                person={entry.person}
                size={32}
              />
            ))}
          </div>
        ) : null}
        {guest ? (
          <>
            <Row row={guestModel.rows[0]}>{nameField}</Row>
            <Row row={guestModel.rows[1]} onMicAction={onMicAction}>
              {mic.status === "ready" ? (
                <span
                  className="sys-room-meter sys-join-meter"
                  aria-hidden="true"
                >
                  <span
                    className="sys-room-meter-fill"
                    style={{ "--sys-room-level": mic.level } as CSSProperties}
                  />
                  <span
                    className="sys-join-clip"
                    data-lit={mic.clipped ? "" : undefined}
                  />
                </span>
              ) : null}
              <div role="status" className="sys-join-notes">
                {guestModel.micNotes.map((note) => (
                  <p key={note.text} className="sys-join-note">
                    <SystemIcon name="triangle-alert" size={16} />
                    {note.text}
                  </p>
                ))}
              </div>
            </Row>
            <Row row={guestModel.rows[2]}>
              <ToggleButton
                pressed={headphones}
                onClick={() => onHeadphonesChange?.(!headphones)}
              >
                <SystemIcon name="headphones" size={16} />
                {JOIN_TEXT.headphones}
              </ToggleButton>
            </Row>
            <Consent host={host} listeners={listenersLine(here)} />
          </>
        ) : (
          <>
            <Row row={producerModel.row}>{nameField}</Row>
            <p className="sys-join-line sys-join-listen">
              <SystemIcon name="headphones" size={24} />
              {JOIN_TEXT.producerLine}
            </p>
          </>
        )}
      </form>
    </Sheet>
  );
}
