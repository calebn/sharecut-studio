import { useCallback, useEffect, useRef, useState } from "react";
import {
  type BootstrapStatus,
  fetchBootstrapStatus,
  runBootstrap,
  type WhisperModelChoice,
  waitForBootstrapJob,
} from "../api";
import { Button, Field } from "../ui";

export type BootstrapWizardProps = {
  onReady: () => void;
  onSkip?: () => void;
};

type JobSnap = {
  id: string;
  status: string;
  message?: string | null;
  current?: number | null;
  total?: number | null;
  error?: string | null;
  elapsed_sec?: number;
};

export function BootstrapWizard({ onReady, onSkip }: BootstrapWizardProps) {
  const [status, setStatus] = useState<BootstrapStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<JobSnap | null>(null);
  const [includeRnnoise, setIncludeRnnoise] = useState(false);
  const [whisperModel, setWhisperModel] = useState("");
  const [models, setModels] = useState<WhisperModelChoice[]>([]);
  const fetchGen = useRef(0);

  const refresh = useCallback(
    async (model?: string) => {
      const gen = ++fetchGen.current;
      setLoading(true);
      setError(null);
      try {
        const next = await fetchBootstrapStatus(model);
        if (gen !== fetchGen.current) {
          return;
        }
        setStatus(next);
        if (next.whisper_models?.length) {
          setModels(next.whisper_models);
        }
        if (!model) {
          setWhisperModel(next.whisper_model);
        }
        if (next.ready) {
          onReady();
        }
      } catch (e: unknown) {
        if (gen !== fetchGen.current) {
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (gen === fetchGen.current) {
          setLoading(false);
        }
      }
    },
    [onReady],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onModelChange = async (nextModel: string) => {
    setWhisperModel(nextModel);
    await refresh(nextModel);
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    const components = ["ffmpeg", "whisper"];
    if (includeRnnoise) {
      components.push("rnnoise");
    }
    try {
      const started = await runBootstrap({
        components,
        whisper_model: whisperModel,
      });
      setJob(started.job);
      const finished = await waitForBootstrapJob(started.job.id, {
        onUpdate: (next) => setJob(next),
      });
      setJob(finished);
      setBusy(false);
      void refresh(whisperModel);
    } catch (e: unknown) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (loading && !status) {
    return (
      <div className="box elevated bootstrap-wizard" role="status">
        <p>Checking installed tools…</p>
      </div>
    );
  }

  if (status?.ready) {
    return null;
  }

  const ffmpegOk = status?.components.ffmpeg?.ok;
  const whisperOk = status?.components.whisper?.ok;
  const selected = models.find((m) => m.id === whisperModel);

  return (
    <div
      className="box elevated bootstrap-wizard stack"
      role="region"
      aria-label="Setup"
    >
      <div className="bootstrap-wizard-header stack">
        <h1>Set up Sharecut Studio</h1>
        <p>
          Download FFmpeg and a Whisper speech model once. Nothing downloads
          until you click Continue. The recommended model has the lowest
          practical WER; pick a smaller one only if you need to save disk.
        </p>
      </div>
      {error ? (
        <p className="home-screen-error" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="bootstrap-wizard-list">
        <li>FFmpeg — {ffmpegOk ? "ready" : "needed for audio"}</li>
        <li>
          Whisper {whisperModel} —{" "}
          {whisperOk ? "ready" : "needed for transcription"}
        </li>
      </ul>
      <Field
        label="Speech model"
        htmlFor="whisper-model"
        hint={
          selected
            ? `${selected.size}. ${selected.description}`
            : "Recommended is large-v3-turbo (~1.6 GB)."
        }
      >
        <select
          id="whisper-model"
          value={whisperModel}
          disabled={busy || models.length === 0}
          onChange={(e) => void onModelChange(e.target.value)}
        >
          {models.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label} ({opt.id}, {opt.size})
            </option>
          ))}
        </select>
      </Field>
      <label className="bootstrap-wizard-optional">
        <input
          type="checkbox"
          checked={includeRnnoise}
          disabled={busy}
          onChange={(e) => setIncludeRnnoise(e.target.checked)}
        />
        Also download RNNoise model (optional noise reduction)
      </label>
      {job && busy ? (
        <p
          className="bootstrap-wizard-progress"
          role="status"
          aria-live="polite"
        >
          {job.message || "Working…"}
          {job.total != null && job.current != null
            ? ` (${job.current}/${job.total})`
            : ""}
          {job.elapsed_sec != null ? ` · ${job.elapsed_sec.toFixed(0)}s` : ""}
        </p>
      ) : null}
      <div className="cluster">
        <Button variant="primary" onClick={() => void start()} disabled={busy}>
          {busy ? "Downloading…" : "Continue"}
        </Button>
        {onSkip ? (
          <Button onClick={onSkip} disabled={busy} variant="link">
            Skip for now
          </Button>
        ) : null}
      </div>
    </div>
  );
}
