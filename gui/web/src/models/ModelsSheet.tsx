import { useViewportClass } from "../hooks/useViewportClass";
import { Sheet } from "../system/Sheet";
import { StatusRow } from "../system/StatusRow";
import { InlineError } from "../ui";
import { modelActivity } from "./activity";
import { inSheetOrder, WHISPER, WHISPER_SIZES } from "./capability";
import { progressText } from "./format";
import { ModelNeedRow } from "./ModelNeedRow";
import { unsupportedSentence } from "./unsupported";
import { useModels } from "./useModels";
import { WhisperSize } from "./WhisperSize";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function ModelsSheet({ open, onClose }: Props) {
  const phone = useViewportClass() === "phone";
  const {
    models,
    downloads,
    tools,
    busy,
    loadError,
    refresh,
    observation,
    download,
    cancel,
  } = useModels();
  const otherDownloads = downloads.filter(
    (row) =>
      !models?.some(
        (selected) =>
          selected.id === row.id && selected.variant === row.variant,
      ),
  );
  return (
    <Sheet
      form={phone ? "bottom" : "end"}
      open={open}
      onClose={onClose}
      title="Models"
      detent="full"
      panelClassName="models-sheet"
    >
      <div className="models-sheet-body">
        {observation.kind === "current" &&
        models !== null &&
        tools.ffmpeg === "unsupported" ? (
          <StatusRow state="queued" title={unsupportedSentence(tools.hint)} />
        ) : null}
        {observation.kind === "current" &&
        models !== null &&
        tools.ffmpeg !== "installed" &&
        tools.ffmpeg !== "unsupported" ? (
          <StatusRow
            state="failed"
            title="Audio tools are unavailable"
            detail="Reinstall ShareCut Studio to restore them."
          />
        ) : null}
        <InlineError message={loadError} origin="state" />
        {models === null && loadError ? (
          <StatusRow
            state="failed"
            title="Couldn't check what is installed"
            action={{
              label: "Try again",
              name: "Try again to check model status",
              onAction: () => void refresh(),
            }}
          />
        ) : null}
        {models === null ? (
          loadError ? null : (
            <p className="models-sheet-wait" role="status">
              Checking what is installed
            </p>
          )
        ) : (
          <>
            <ul className="models-sheet-list">
              {inSheetOrder(models).map((m) => (
                <li key={m.id}>
                  <ModelNeedRow model={m} placement="list">
                    {m.id === WHISPER && m.state.kind !== "unsupported" ? (
                      <WhisperSize disabled={busy} />
                    ) : null}
                  </ModelNeedRow>
                </li>
              ))}
            </ul>
            {otherDownloads.map((m) => {
              const sizeName =
                WHISPER_SIZES.find((size) => size.id === m.variant)?.name ??
                m.variant;
              const name = `Transcription ${sizeName}`;
              const state = m.state;
              const failed = state.kind === "failed";
              const detail =
                state.kind === "downloading"
                  ? progressText(state)
                  : failed
                    ? state.failure.plain
                    : "Waiting";
              const progress =
                state.kind === "downloading" &&
                state.total != null &&
                state.total > 0
                  ? state.bytes / state.total
                  : undefined;
              return (
                <section
                  key={`${m.id}/${m.variant}`}
                  role="group"
                  aria-label={name}
                >
                  <StatusRow
                    state={failed ? "failed" : "running"}
                    title={failed ? `Couldn't get ${name}` : `Getting ${name}`}
                    detail={detail}
                    progress={failed ? undefined : progress}
                    barLabel={`Getting ${name}`}
                    action={
                      failed
                        ? {
                            label: "Try again",
                            name: "Try again Transcription",
                            disabledReason: modelActivity(m, busy)
                              .blockedReason,
                            onAction: () =>
                              void download([m.id], {
                                whisperModel: m.variant ?? undefined,
                              }),
                          }
                        : {
                            label: "Cancel",
                            name: "Cancel Transcription download",
                            onAction: () => void cancel(),
                          }
                    }
                  />
                </section>
              );
            })}
          </>
        )}
      </div>
    </Sheet>
  );
}
