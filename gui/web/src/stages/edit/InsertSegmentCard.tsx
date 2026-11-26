import {
  type FormEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  isDamagedSegment,
  type SegmentInsertPreview,
  type SegmentInsertRequest,
  type SegmentListRow,
  type SegmentPlacement,
  type SegmentRow,
  segmentInsertRefusal,
} from "../../api";
import {
  DIALOGUE_OWN_LANE_HINT,
  defaultInsertPosition,
  defaultPlacement,
  INSERT_POSITIONS,
  type InsertPosition,
  insertAtOf,
  insertPreviewLines,
  isDialogueSegment,
  PLACEMENT_OPTIONS,
  segmentInsertMessage,
  segmentPreviewMessage,
} from "../../edit/segmentInsertMessages";
import {
  KIND_LABEL,
  segmentLengthSec,
  versionTag,
} from "../../segments/format";
import { Button, Field } from "../../ui";
import { InlineError } from "../../ui/InlineError";
import { formatTimeShort } from "../../utils/time";
import { SegmentCardFrame } from "./SegmentCardFrame";
import { useCrampedSheet } from "./useCrampedSheet";

const TITLE = "Insert segment";
export const INSERT_EMPTY_LIBRARY =
  "Your library is empty. Save clips as a segment first, with Save as segment in the More menu.";
const LOADING_LIBRARY = "Loading your library.";
const CHECKING = "Checking what this will change.";
const INSERTING = "Inserting into the episode.";
const PICK_FIRST = "Pick a segment first.";

const POSITION_LABELS: Record<Exclude<InsertPosition, "playhead">, string> = {
  start: "At start",
  end: "At end",
};

type Common = {
  rows: readonly SegmentListRow[] | null;
  loadError: string | null;
  onRetryLoad: () => void;
  playheadSec: number;
  timelineEnd: number;
  loadPreview: (
    request: SegmentInsertRequest,
    signal: AbortSignal,
  ) => Promise<SegmentInsertPreview>;
  onInsert: (input: {
    name: string;
    request: SegmentInsertRequest;
  }) => Promise<void>;
  onClose: () => void;
};

export type InsertSegmentCardProps = Common &
  (
    | {
        form?: "anchored";
        anchorRef: RefObject<HTMLElement | null>;
        open?: boolean;
      }
    | {
        form: "bottom";
        open: boolean;
        anchorRef?: undefined;
      }
  );

type PreviewState = {
  key: string;
  data?: SegmentInsertPreview;
  error?: string;
};

type FormState = {
  rows: readonly SegmentListRow[] | null;
  loadError: string | null;
  onRetryLoad: () => void;
  playheadSec: number;
  selected: SegmentRow | null;
  pick: (id: string) => void;
  position: InsertPosition;
  pickPosition: (value: InsertPosition) => void;
  placement: SegmentPlacement;
  pickPlacement: (value: SegmentPlacement) => void;
  current: PreviewState | null;
  retryPreview: () => void;
  failure: string | null;
  inserting: boolean;
  disabledReason: string | undefined;
  submit: (event: FormEvent) => Promise<void>;
};

const usable = (row: SegmentListRow): row is SegmentRow =>
  !isDamagedSegment(row);

function useInsertForm(
  props: Common,
  listRef: RefObject<HTMLFieldSetElement | null>,
): FormState & { busy: RefObject<boolean> } {
  const busy = useRef(false);
  const { rows, playheadSec, timelineEnd, onInsert, onClose } = props;
  const { loadPreview } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [picked, setPicked] = useState<InsertPosition | null>(null);
  const [pickedPlacement, setPickedPlacement] =
    useState<SegmentPlacement | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [round, setRound] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [inserting, setInserting] = useState(false);
  const insertInFlight = useRef(false);

  const selected =
    rows?.find(
      (row): row is SegmentRow => usable(row) && row.id === selectedId,
    ) ?? null;
  const position =
    picked ?? (selected ? defaultInsertPosition(selected.kind) : "playhead");
  const at = selected ? insertAtOf(position, playheadSec, timelineEnd) : null;
  const placement: SegmentPlacement = isDialogueSegment(selected)
    ? "ripple"
    : (pickedPlacement ?? defaultPlacement(selected));
  const key = selected
    ? `${selected.id}|${String(at)}|${placement}|${round}`
    : null;
  const current = preview && preview.key === key ? preview : null;

  const segmentId = selected?.id ?? null;
  useEffect(() => {
    if (segmentId === null || at === null || key === null) return;
    const controller = new AbortController();
    loadPreview(
      {
        segment_id: segmentId,
        at,
        ...(placement === "own_lane" ? { placement } : {}),
      },
      controller.signal,
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        setPreview({ key, data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (segmentInsertRefusal(error) === "segment_placement_unsupported")
          setPickedPlacement("ripple");
        setPreview({ key, error: segmentPreviewMessage(error) });
      });
    return () => controller.abort();
  }, [segmentId, at, placement, key, loadPreview]);

  const disabledReason = inserting
    ? INSERTING
    : !selected
      ? rows === null
        ? props.loadError
          ? "Your saved segments could not be read."
          : LOADING_LIBRARY
        : rows.length > 0 && rows.some(usable)
          ? PICK_FIRST
          : "There is no segment to insert."
      : !current
        ? CHECKING
        : current.error
          ? current.error
          : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (insertInFlight.current || !selected || at === null) return;
    const ready = current?.data;
    if (!ready) return;
    insertInFlight.current = true;
    busy.current = true;
    setInserting(true);
    setFailure(null);
    try {
      await onInsert({
        name: selected.name,
        request: {
          segment_id: selected.id,
          at,
          version: ready.segment_version,
          ...(placement === "own_lane" ? { placement } : {}),
        },
      });
      busy.current = false;
      onClose();
    } catch (error) {
      if (segmentInsertRefusal(error) === "segment_placement_unsupported")
        setPickedPlacement("ripple");
      setFailure(segmentInsertMessage(error));
      insertInFlight.current = false;
      busy.current = false;
      setInserting(false);
      (
        listRef.current?.querySelector<HTMLElement>("input:checked") ??
        listRef.current?.querySelector<HTMLElement>("input:not(:disabled)")
      )?.focus();
    }
  };

  return {
    busy,
    rows,
    loadError: props.loadError,
    onRetryLoad: props.onRetryLoad,
    playheadSec,
    selected,
    pick: (id) => {
      if (insertInFlight.current) return;
      setSelectedId(id);
      setPickedPlacement(null);
      setFailure(null);
    },
    position,
    pickPosition: (value) => {
      if (insertInFlight.current) return;
      setPicked(value);
      setFailure(null);
    },
    placement,
    pickPlacement: (value) => {
      if (insertInFlight.current) return;
      setPickedPlacement(value);
      setFailure(null);
    },
    current,
    retryPreview: () => setRound((n) => n + 1),
    failure,
    inserting,
    disabledReason,
    submit,
  };
}

function SegmentOption({
  row,
  name,
  checked,
  onPick,
  first,
}: {
  row: SegmentListRow;
  name: string;
  checked: boolean;
  onPick: (pointer: boolean) => void;
  first: RefObject<HTMLInputElement | null> | null;
}) {
  const damaged = isDamagedSegment(row);
  const inputId = useId();
  const meta = damaged
    ? `${row.problem} It cannot be inserted.`
    : `${KIND_LABEL[row.kind]}, ${formatTimeShort(segmentLengthSec(row))}, ${versionTag(row)}`;
  return (
    <label
      htmlFor={inputId}
      className={
        damaged
          ? "sys-segment-option sys-segment-option--damaged"
          : "sys-segment-option"
      }
    >
      <input
        id={inputId}
        ref={first}
        type="radio"
        name={name}
        value={row.id}
        checked={checked}
        disabled={damaged}
        onChange={(event) =>
          onPick(
            event.nativeEvent instanceof MouseEvent &&
              event.nativeEvent.detail > 0,
          )
        }
      />
      {damaged ? row.id : row.name}
      <span className="sys-segment-option-meta">{meta}</span>
    </label>
  );
}

function PlacementGroup({
  name,
  placement,
  dialogue,
  disabled,
  onPick,
  groupRef,
}: {
  groupRef?: RefObject<HTMLFieldSetElement | null>;
  name: string;
  placement: SegmentPlacement;
  dialogue: boolean;
  disabled: boolean;
  onPick: (value: SegmentPlacement) => void;
}) {
  const hintId = useId();
  return (
    <fieldset ref={groupRef} className="sys-segment-placement">
      <legend className="ui-field-label">What happens to the episode</legend>
      {PLACEMENT_OPTIONS.map((option) => {
        const blocked = dialogue && option.value === "own_lane";
        return (
          <label key={option.value} className="sys-segment-option">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={placement === option.value}
              disabled={disabled || blocked}
              aria-describedby={blocked ? hintId : undefined}
              onChange={() => onPick(option.value)}
            />
            {option.label}
            <span className="sys-segment-option-meta">{option.hint}</span>
          </label>
        );
      })}
      {dialogue ? (
        <p id={hintId} className="sys-segment-summary">
          {DIALOGUE_OWN_LANE_HINT}
        </p>
      ) : null}
    </fieldset>
  );
}

function InsertActions({
  state,
  inserting,
  onClose,
  formId,
}: {
  state: FormState;
  inserting: boolean;
  onClose: () => void;
  formId: string;
}) {
  return (
    <div className="sys-segment-actions">
      <Button
        type="button"
        onClick={onClose}
        disabledReason={inserting ? INSERTING : undefined}
      >
        Cancel
      </Button>
      <Button
        type="submit"
        form={formId}
        variant="primary"
        disabledReason={state.disabledReason}
      >
        Insert
      </Button>
    </div>
  );
}

function InsertSegmentForm({
  state,
  onClose,
  bottom,
  pinned,
  formId,
  listRef,
  firstRadio,
}: {
  state: FormState;
  onClose: () => void;
  bottom: boolean;
  pinned: boolean;
  formId: string;
  listRef: RefObject<HTMLFieldSetElement | null>;
  firstRadio: RefObject<HTMLInputElement | null>;
}) {
  const { rows, selected, current, inserting } = state;
  const group = useId();
  const placementGroup = useId();
  const firstUsable = rows?.findIndex(usable) ?? -1;
  const listed = rows !== null && rows.length > 0;
  const placementRef = useRef<HTMLFieldSetElement>(null);
  const pickedId = selected?.id ?? null;
  const pointerPick = useRef(false);
  const shownFor = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const previous = shownFor.current;
    shownFor.current = pickedId;
    const first = previous === null && pickedId !== null;
    if (!bottom || !first || !pointerPick.current) return;
    placementRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [bottom, pickedId]);

  useEffect(() => {
    if (!listed) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const active = document.activeElement;
        if (
          !active ||
          active === document.body ||
          active.closest(".dialog-close, .bottom-sheet-header")
        )
          firstRadio.current?.focus({ preventScroll: true });
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [listed, firstRadio]);

  return (
    <form
      id={formId}
      className={
        bottom
          ? "sys-segment-form sys-segment-form--bottom"
          : "sys-segment-form"
      }
      noValidate
      onSubmit={(event) => void state.submit(event)}
    >
      {state.loadError ? (
        <>
          <InlineError message={state.loadError} />
          <Button type="button" onClick={state.onRetryLoad}>
            Try again
          </Button>
        </>
      ) : rows === null ? (
        <p className="sys-segment-summary" role="status">
          {LOADING_LIBRARY}
        </p>
      ) : rows.length === 0 ? (
        <p className="sys-segment-summary">{INSERT_EMPTY_LIBRARY}</p>
      ) : (
        <>
          <fieldset ref={listRef} className="sys-segment-list">
            <legend className="ui-field-label">Segment</legend>
            {rows.map((row, index) => (
              <SegmentOption
                key={row.id}
                row={row}
                name={group}
                checked={selected?.id === row.id}
                onPick={(pointer) => {
                  pointerPick.current = pointer;
                  state.pick(row.id);
                }}
                first={index === firstUsable ? firstRadio : null}
              />
            ))}
          </fieldset>
          {selected ? (
            <PlacementGroup
              name={placementGroup}
              placement={state.placement}
              dialogue={isDialogueSegment(selected)}
              disabled={inserting}
              onPick={state.pickPlacement}
              groupRef={placementRef}
            />
          ) : null}
          <Field label="Position">
            {(control) => (
              <select
                {...control}
                disabled={inserting}
                value={state.position}
                onChange={(event) =>
                  state.pickPosition(event.target.value as InsertPosition)
                }
              >
                {INSERT_POSITIONS.map((option) => (
                  <option key={option} value={option}>
                    {option === "playhead"
                      ? `At playhead (${formatTimeShort(state.playheadSec)})`
                      : POSITION_LABELS[option]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="sys-segment-preview" aria-live="polite">
            {selected && !current ? (
              <p className="sys-segment-summary">{CHECKING}</p>
            ) : null}
            {current?.error ? (
              <>
                <InlineError message={current.error} origin="state" />
                <Button type="button" onClick={state.retryPreview}>
                  Try again
                </Button>
              </>
            ) : null}
            {current?.data ? (
              <>
                <p className="sys-segment-summary">
                  Preview, from the saved episode:
                </p>
                <ul className="sys-segment-preview-lines">
                  {insertPreviewLines(
                    current.data,
                    state.placement,
                    selected,
                  ).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        </>
      )}
      {inserting ? (
        <p className="sys-segment-summary" role="status">
          {INSERTING}
        </p>
      ) : null}
      <InlineError message={state.failure} />
      {pinned ? null : (
        <InsertActions
          state={state}
          inserting={inserting}
          onClose={onClose}
          formId={formId}
        />
      )}
    </form>
  );
}

export function InsertSegmentCard(props: InsertSegmentCardProps) {
  const { open = true } = props;
  const listRef = useRef<HTMLFieldSetElement>(null);
  const firstRadio = useRef<HTMLInputElement>(null);
  const state = useInsertForm(props, listRef);
  const { busy } = state;
  const formId = useId();
  const cramped = useCrampedSheet();
  const pinned = props.form === "bottom" && !cramped;
  const close = () => {
    if (!busy.current) props.onClose();
  };
  const content = (
    <InsertSegmentForm
      state={state}
      onClose={close}
      bottom={props.form === "bottom"}
      pinned={pinned}
      formId={formId}
      listRef={listRef}
      firstRadio={firstRadio}
    />
  );
  const frame = {
    title: TITLE,
    open,
    busy,
    onClose: props.onClose,
    initialFocusRef: firstRadio,
  };
  return props.form === "bottom" ? (
    <SegmentCardFrame
      {...frame}
      form="bottom"
      footer={
        pinned ? (
          <InsertActions
            state={state}
            inserting={state.inserting}
            onClose={close}
            formId={formId}
          />
        ) : undefined
      }
    >
      {content}
    </SegmentCardFrame>
  ) : (
    <SegmentCardFrame {...frame} anchorRef={props.anchorRef}>
      {content}
    </SegmentCardFrame>
  );
}
