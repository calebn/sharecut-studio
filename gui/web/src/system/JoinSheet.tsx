import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { Button } from "../ui";
import type { DrawerDetent } from "../ui/BottomSheet";
import { BUSY_REASON } from "../ui/disabledReason";
import { HeadphonesToggle } from "./HeadphonesToggle";
import {
  consentDetails,
  consentLine,
  JOIN_TEXT,
  type JoinBlocker,
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
import { MicRow } from "./MicRow";
import { PersonAvatar, type PersonData } from "./Person";
import type { RoomRole } from "./roomViewModel";
import { Sheet } from "./Sheet";
import { SheetRow } from "./SheetRow";
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
  /** Extra lines under the mic meter, such as "your saved microphone is gone". */
  micNotes?: string[];
  /** Storage that cannot keep a recording; the first reason, before the name. */
  blocker?: JoinBlocker;
  onBlockerAction?: () => void;
  onMicAction?: (action: JoinMicAction) => void;
  /** The input picked in the mic row; `mic.devices` fills the list. */
  onInputChange?: (inputId: string) => void;
  joining?: boolean;
  /** Back from Not now: the sheet opens on the consent step, with Join recording focused. */
  rejoin?: boolean;
  onJoin: () => void;
  /** Not now, Escape and Close all decline. */
  onDecline: () => void;
};

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
  primaryRef,
  onJoin,
  onDecline,
}: {
  primary: JoinPrimary;
  primaryRef: RefObject<HTMLButtonElement | null>;
  onJoin: () => void;
  onDecline: () => void;
}) {
  const reasonId = useId();
  return (
    <div className="sys-join-footer">
      <Button
        ref={primaryRef}
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
  micNotes,
  blocker,
  onBlockerAction,
  onMicAction,
  onInputChange,
  joining = false,
  rejoin = false,
  onJoin,
  onDecline,
}: JoinSheetProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [detent, setDetent] = useState<DrawerDetent>("full");
  const phone = viewerWidth === "phone";
  const guest = seat === "guest";
  const guestModel = joinGuestModel({
    name,
    mic,
    headphones,
    lowStorage,
    micNotes,
    blocker,
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

  const rowOf = (key: JoinStep) =>
    guestModel.rows.find((row) => row.key === key) as JoinRow;
  const act = (kind: NonNullable<JoinRow["action"]>["kind"]) =>
    kind === "blocker" ? onBlockerAction?.() : onMicAction?.(kind);
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
      initialFocusRef={phone ? undefined : rejoin ? primaryRef : nameRef}
      onClose={onDecline}
      footer={
        <Footer
          primary={primary}
          primaryRef={primaryRef}
          onJoin={onJoin}
          onDecline={onDecline}
        />
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
            {blocker ? (
              <SheetRow row={rowOf("storage")} onAction={act} />
            ) : null}
            <SheetRow row={rowOf("name")}>{nameField}</SheetRow>
            <SheetRow row={rowOf("mic")} onAction={act}>
              <MicRow
                mic={mic}
                notes={guestModel.micNotes}
                onInputChange={onInputChange}
              />
            </SheetRow>
            <SheetRow row={rowOf("headphones")}>
              <HeadphonesToggle
                pressed={headphones}
                onChange={onHeadphonesChange}
              />
            </SheetRow>
            <Consent host={host} listeners={listenersLine(here)} />
          </>
        ) : (
          <>
            <SheetRow row={producerModel.row}>{nameField}</SheetRow>
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
