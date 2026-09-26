import { useEffect, useId, useRef } from "react";
import { Button, Field } from "../ui";
import {
  copyForMicStatus,
  MIC_ALLOW_LABEL,
  MIC_RETRY_LABEL,
  type MicPermissionStatus,
  micGrantFailed,
} from "./micPermission";
import { SPEAKERS_WARNING } from "./types";

type Props = {
  headphonesOk: boolean;
  deviceId: string;
  onDeviceId: (id: string) => void;
  stream: MediaStream | null;
  devices: MediaDeviceInfo[];
  error: string | null;
  settingsWarning: string | null;
  notice?: string | null;
  deviceLocked?: boolean;
  permission: MicPermissionStatus;
  onAllow: () => void;
  onRetry: () => void;
  grantHintId: string;
  headphonesHintId: string;
};

export function DeviceCheck({
  headphonesOk,
  deviceId,
  onDeviceId,
  stream,
  devices,
  error,
  settingsWarning,
  notice,
  deviceLocked = false,
  permission,
  onAllow,
  onRetry,
  grantHintId,
  headphonesHintId,
}: Props) {
  const meterId = useId();
  const selectId = useId();
  const meterRef = useRef<HTMLMeterElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const wasGranted = useRef(false);
  const granted = permission === "granted";
  const failed = micGrantFailed(permission);
  const grantCopy = copyForMicStatus(permission);
  const prompting = permission === "prompting";

  useEffect(() => {
    if (granted && !wasGranted.current) {
      selectRef.current?.focus();
    }
    wasGranted.current = granted;
  }, [granted]);

  useEffect(() => {
    if (!stream) {
      return;
    }
    let ctx: AudioContext | null = null;
    let raf = 0;
    let cancelled = false;
    try {
      ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (cancelled) {
          return;
        }
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) {
          const n = (v - 128) / 128;
          sum += n * n;
        }
        const level = Math.min(1, Math.sqrt(sum / data.length) * 4);
        if (meterRef.current) {
          meterRef.current.value = level;
        }
        raf = window.requestAnimationFrame(tick);
      };
      tick();
    } catch {
      void ctx?.close();
      ctx = null;
    }
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      void ctx?.close();
    };
  }, [stream]);

  return (
    <section className="stack" aria-labelledby="device-heading">
      <h2 id="device-heading">Microphone</h2>
      {granted ? (
        <>
          <Field label="Input" htmlFor={selectId}>
            <select
              ref={selectRef}
              id={selectId}
              value={deviceId}
              disabled={deviceLocked}
              onChange={(e) => onDeviceId(e.target.value)}
            >
              <option value="">Default</option>
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || "Microphone"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Level" htmlFor={meterId}>
            <meter
              ref={meterRef}
              id={meterId}
              min={0}
              max={1}
              defaultValue={0}
            />
          </Field>
        </>
      ) : (
        <div className="cluster">
          {failed ? (
            <Button
              type="button"
              onClick={onRetry}
              aria-describedby={grantHintId}
            >
              {MIC_RETRY_LABEL}
            </Button>
          ) : (
            <Button
              variant="primary"
              type="button"
              onClick={onAllow}
              disabled={prompting}
              aria-busy={prompting}
              aria-describedby={grantHintId}
            >
              {MIC_ALLOW_LABEL}
            </Button>
          )}
        </div>
      )}
      {!headphonesOk ? (
        <p id={headphonesHintId} className="record-warn">
          {SPEAKERS_WARNING}
        </p>
      ) : null}
      <div aria-live="polite">
        {grantCopy ? (
          <p
            id={grantHintId}
            role={prompting ? "status" : undefined}
            className={failed ? "record-warn" : undefined}
          >
            {grantCopy}
          </p>
        ) : (
          <span id={grantHintId} className="sr-only" />
        )}
        {notice ? <p className="record-warn">{notice}</p> : null}
        {settingsWarning ? (
          <p className="record-warn">{settingsWarning}</p>
        ) : null}
        {error && permission !== "denied" && permission !== "unavailable" ? (
          <p className="record-warn">{error}</p>
        ) : null}
      </div>
    </section>
  );
}
