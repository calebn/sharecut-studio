import {
  type FormEvent,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { initialPointerKind } from "../hooks/usePointerType";
import { Button } from "../ui";
import { Dialog } from "../ui/Dialog";
import { BUSY_REASON } from "../ui/disabledReason";
import { COMMENT_NAME_MAX } from "../utils/commentAuthor";
import { HeadphonesToggle } from "./HeadphonesToggle";
import {
  consentDetails,
  consentLine,
  JOIN_TEXT,
  type JoinBlocker,
  type JoinFocus,
  type JoinMic,
  type JoinMicAction,
  type JoinPrimary,
  type JoinRow,
  type JoinRowAction,
  type JoinStep,
  joinFocus,
  joinGuestModel,
  joinHeadline,
  joinProducerModel,
  listenersLine,
} from "./joinSheetModel";
import { MicRow } from "./MicRow";
import { PersonAvatar, type PersonData } from "./Person";
import type { RoomRole } from "./roomViewModel";
import { SheetRow } from "./SheetRow";
import { SystemIcon } from "./SystemIcon";

type JoinHere = { person: PersonData; role: RoomRole };

export type JoinSheetProps = {
  seat: "guest" | "producer";
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
  onJoin: () => void;
  /** Not now, Escape and Close all decline. A press beside the sheet does not. */
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
      <Button
        variant="link"
        aria-expanded={open}
        aria-controls={open ? detailsId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        Details
      </Button>
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
        onClick={primary.busy ? undefined : onJoin}
        aria-busy={primary.busy || undefined}
        aria-disabled={primary.busy || undefined}
        title={primary.busy ? BUSY_REASON : undefined}
        aria-describedby={primary.reason ? reasonId : undefined}
        disabledReason={
          primary.busy ? undefined : (primary.reason ?? undefined)
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

function micStatusLine(row: JoinRow): string {
  if (row.state === "running") return row.detail ?? "";
  if (row.state === "needs-you" || row.state === "failed") {
    return [row.title, row.detail]
      .filter((part): part is string => Boolean(part))
      .map((part) => (/[.!?…]$/.test(part) ? part : `${part}.`))
      .join(" ");
  }
  return "";
}

/** The element for a focus target: a row's first enabled control, else the row. */
function focusElement(
  form: HTMLFormElement | null,
  name: HTMLInputElement | null,
  primary: HTMLButtonElement | null,
  focus: JoinFocus,
): HTMLElement | null {
  if (focus.kind === "name-field") return name;
  if (focus.kind === "primary") return primary?.disabled ? null : primary;
  const row = form?.querySelector<HTMLElement>(`[data-step="${focus.step}"]`);
  if (!row || focus.step === "name") return row ?? null;
  return (
    row.querySelector<HTMLElement>(
      "button:not(:disabled, [aria-disabled='true']), input",
    ) ?? row
  );
}

/**
 * The pre-join sheet over a live room, one Dialog at every width: a card from
 * 600 px, a bottom sheet under it (system-record.css decides). Rows check
 * themselves off as the caller's state moves; the primary stays disabled and
 * names the first row still to do. Presentational: the caller owns the name,
 * the mic and the join itself. Not now, Escape and Close all decline; a press
 * beside the sheet does not.
 */
export function JoinSheet({
  seat,
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
  onJoin,
  onDecline,
}: JoinSheetProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [pointer] = useState(initialPointerKind);
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

  const nextRef = useRef(next);
  // Focus the guest already put in the form stays: typing can begin before the
  // sheet's first frame places focus.
  const initialFocusRef = useMemo(
    () => ({
      get current() {
        const active = document.activeElement;
        if (
          active instanceof HTMLElement &&
          formRef.current?.contains(active) &&
          !active.matches(".sys-join-row")
        ) {
          return active;
        }
        return focusElement(
          formRef.current,
          nameRef.current,
          primaryRef.current,
          joinFocus(nextRef.current, pointer),
        );
      },
    }),
    [pointer],
  );

  // A row the sheet parked focus on (a wait, such as the browser's prompt or
  // the storage check) hands it on when the row resolves, including when the
  // row itself unmounts and focus falls to the page. Focus the guest chose
  // stays put.
  useEffect(() => {
    if (nextRef.current === next) return;
    nextRef.current = next;
    const active = document.activeElement;
    const parked =
      active instanceof HTMLElement && active.matches(".sys-join-row");
    const dropped = !active || active === document.body;
    if (!parked && !dropped) return;
    focusElement(
      formRef.current,
      nameRef.current,
      primaryRef.current,
      joinFocus(next, pointer),
    )?.focus();
  }, [next, pointer]);

  // "fine": Enter means a keyboard is in use, so the name field is the right target.
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (joining) return;
    if (ready) {
      onJoin();
      return;
    }
    focusElement(
      formRef.current,
      nameRef.current,
      primaryRef.current,
      joinFocus(next, "fine"),
    )?.focus();
  };

  const rowOf = (key: JoinStep) =>
    guestModel.rows.find((row) => row.key === key) as JoinRow;
  const act = (kind: JoinRowAction["kind"]) =>
    kind === "blocker" ? onBlockerAction?.() : onMicAction?.(kind);
  const nameField = (
    <input
      ref={nameRef}
      type="text"
      className="sys-join-input"
      aria-label="Your name"
      autoComplete="name"
      autoCapitalize="words"
      autoCorrect="off"
      spellCheck={false}
      maxLength={COMMENT_NAME_MAX}
      enterKeyHint={ready ? "go" : "next"}
      value={name}
      onChange={(event) => onNameChange(event.target.value)}
    />
  );

  return (
    <Dialog
      open
      title={joinHeadline(here)}
      panelClassName="sys-join-sheet sys-join-dialog"
      initialFocusRef={initialFocusRef}
      scrimDismisses={false}
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
              <p className="sr-only" role="status">
                {micStatusLine(rowOf("mic"))}
              </p>
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
    </Dialog>
  );
}
