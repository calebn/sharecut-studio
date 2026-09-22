import { useEffect, useMemo, useState } from "react";
import { ErrorScreen, FocusPull, LoadingScreen } from "../ui";
import "../styles/partials/record-entry.css";
import { useDesktopCloseGuard } from "../desktop/useDesktopCloseGuard";
import { Declined } from "./Declined";
import { FullRoom } from "./FullRoom";
import { type ByteSink, createOpfsSink } from "./keeper/store";
import { useKeeperCapture } from "./keeper/useKeeperCapture";
import { Lobby } from "./Lobby";
import { useRecordMonitor } from "./monitor/useRecordMonitor";
import { Room } from "./Room";
import { loadRecordBootstrap, type RecordBootstrap } from "./recordBootstrap";
import { UPLOAD_SINK_ERROR_COPY } from "./types";
import { guestRecordUploadTransport } from "./upload/http";
import { downloadLocalKeepers } from "./upload/recovery";
import { useRecordUpload } from "./upload/useRecordUpload";
import { useMicPermission } from "./useMicPermission";
import { useRecordLiveComments } from "./useRecordLiveComments";
import { useRecordSync } from "./useRecordSync";
import { useRoomToneCapture } from "./useRoomToneCapture";

function isNotFound(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes("404") ||
    lower.includes("invalid") ||
    lower.includes("revoked") ||
    lower.includes("not found")
  );
}

function storageKey(token: string, suffix: string): string {
  return `record:${token}:${suffix}`;
}

export function RecordApp({ token }: { token: string }) {
  const [bootstrap, setBootstrap] = useState<RecordBootstrap | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [name, setName] = useState(
    () => localStorage.getItem(storageKey(token, "name")) || "",
  );
  const [headphonesOk, setHeadphonesOk] = useState(false);
  const [deviceId, setDeviceId] = useState(
    () => localStorage.getItem(storageKey(token, "mic")) || "",
  );
  const [producerJoined, setProducerJoined] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setBootError(null);
    setBootstrap(null);
    loadRecordBootstrap(token, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setBootstrap(data);
        }
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setBootError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      controller.abort();
    };
  }, [token]);

  useEffect(() => {
    localStorage.setItem(storageKey(token, "name"), name);
  }, [name, token]);

  useEffect(() => {
    localStorage.setItem(storageKey(token, "mic"), deviceId);
  }, [deviceId, token]);

  const producer = bootstrap?.role === "producer";
  const heading = producer ? "Producer — not recorded" : "Join the recording";
  const episodeName = bootstrap?.episode.name.trim() ?? "";

  useEffect(() => {
    if (!bootstrap) {
      return;
    }
    const previous = document.title;
    document.title = episodeName ? `${heading} — ${episodeName}` : heading;
    return () => {
      document.title = previous;
    };
  }, [bootstrap, episodeName, heading]);

  const syncName = name.trim() || (producer ? "Producer" : "Guest");
  const { snapshot, me, send, error, connected, lease } = useRecordSync(
    token,
    syncName,
    !!bootstrap && (!producer || producerJoined),
  );
  const liveComments = useRecordLiveComments({
    token,
    snapshot,
    me,
    connected,
    send,
    captureKeys: true,
  });

  const micEnabled =
    !producer && !!me && error !== "room_full" && me.consented !== false;
  const mic = useMicPermission(micEnabled, deviceId);
  const keeper = useKeeperCapture({
    enabled: !!bootstrap?.build.capture && !producer && me?.consented === true,
    role: "guest",
    snapshot,
    participantId: me?.participant_id ?? null,
    muted: me?.muted ?? false,
    consented: me?.consented ?? null,
    stream: mic.stream,
  });
  useDesktopCloseGuard(
    keeper.recordingLocally ||
      keeper.finalizing ||
      snapshot?.state === "recording" ||
      snapshot?.state === "paused",
    "guest",
    snapshot !== null,
  );
  const monitor = useRecordMonitor({
    enabled: !!bootstrap?.build.monitor && !!me && connected,
    localId: me?.participant_id ?? null,
    role: producer ? "producer" : "guest",
    snapshot,
    localStream: producer || me?.consented !== true ? null : mic.stream,
    muted: me?.muted ?? false,
    send: (payload) => send("Signal", payload),
  });
  const [sink, setSink] = useState<ByteSink | null>(null);
  const [sinkError, setSinkError] = useState<string | null>(null);
  useEffect(() => {
    if (!bootstrap?.build.upload || producer) {
      setSink(null);
      setSinkError(null);
      return;
    }
    let cancelled = false;
    void createOpfsSink()
      .then((next) => {
        if (!cancelled) {
          setSink(next);
          setSinkError(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSinkError(UPLOAD_SINK_ERROR_COPY);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bootstrap?.build.upload, producer]);
  const uploadTransport = useMemo(() => {
    if (!bootstrap?.build.upload || producer || !me?.participant_id || !lease) {
      return null;
    }
    return guestRecordUploadTransport(token, me.participant_id, lease);
  }, [bootstrap?.build.upload, producer, me?.participant_id, lease, token]);
  const [uploadRetryNonce, setUploadRetryNonce] = useState(0);
  const upload = useRecordUpload({
    enabled: !!bootstrap?.build.upload && !producer && me?.consented === true,
    roomState: snapshot?.state,
    captureSettled: !keeper.recordingLocally,
    sessionId: snapshot?.session_id ?? null,
    takeIndex: snapshot?.take_index ?? 0,
    participantId: me?.participant_id ?? null,
    transport: uploadTransport,
    sink,
    retryNonce: uploadRetryNonce,
  });
  const roomTone = useRoomToneCapture({
    enabled:
      !!bootstrap?.build.upload &&
      !producer &&
      !!me?.participant_id &&
      me.consented !== false,
    canUpload: me?.consented === true,
    stream: mic.stream,
    sessionId: snapshot?.session_id ?? null,
    participantId: me?.participant_id ?? null,
    sink,
    transport: uploadTransport,
  });

  const meId = me?.participant_id;
  const myName = me?.display_name;

  useEffect(() => {
    if (meId && name.trim() && name.trim() !== myName) {
      send("UpdateName", { display_name: name.trim() });
    }
  }, [meId, myName, name, send]);

  useEffect(() => {
    if (meId && !producer) {
      send("HeadphonesAck", { ok: headphonesOk });
    }
  }, [headphonesOk, meId, producer, send]);

  const view = useMemo(() => {
    if (error === "room_full") {
      return "full" as const;
    }
    if (me?.consented === false && snapshot && snapshot.state !== "lobby") {
      return "declined" as const;
    }
    if (!producer && me?.consented !== true) {
      return "lobby" as const;
    }
    if (snapshot && (producer || me?.consented === true)) {
      return "room" as const;
    }
    return "lobby" as const;
  }, [error, me, producer, snapshot]);

  if (bootError) {
    const message = isNotFound(bootError)
      ? "This recording link is invalid or has ended."
      : bootError;
    return <ErrorScreen message={message} />;
  }
  if (!bootstrap) {
    return <LoadingScreen label="Loading studio…" />;
  }
  if (view === "full") {
    return <FullRoom />;
  }
  if (view === "declined") {
    return <Declined />;
  }

  const roleCopy = producer ? "You are listening only" : "You will be recorded";

  return (
    <main className="cover review-shell record-shell">
      <div className="cover-center center stack">
        <header className="stack">
          <p className="wordmark">Sharecut Studio</p>
          <h1>{heading}</h1>
          {episodeName ? <p className="lede">{episodeName}</p> : null}
        </header>
        <p className="record-role">{roleCopy}</p>
        {producer && view !== "room" ? <h2>Not recorded</h2> : null}
        <FocusPull viewKey={view}>
          {view === "room" && snapshot ? (
            <Room
              snapshot={snapshot}
              me={me}
              onMute={(muted) => send("SetMuted", { muted })}
              onLeave={() => send("Leave", {})}
              onMarker={liveComments.postMarker}
              onSubmitNote={liveComments.submitNote}
              note={liveComments.note}
              onNote={liveComments.setNote}
              connected={connected}
              recordingLocally={keeper.recordingLocally}
              keeperError={keeper.error}
              uploadSinkError={sinkError}
              onRetryKeeper={keeper.error ? keeper.retry : undefined}
              hearing={monitor.hearing}
              monitorError={monitor.error}
              upload={upload}
              micLost={mic.lost}
              onRetryMic={mic.retry}
              onResumeUpload={() => setUploadRetryNonce((value) => value + 1)}
              onDownloadKeeper={
                sink && me?.participant_id && snapshot
                  ? () => {
                      void downloadLocalKeepers(
                        sink,
                        snapshot.session_id,
                        me.participant_id,
                        snapshot.take_index,
                      ).catch((error: unknown) => {
                        setSinkError(
                          error instanceof Error
                            ? error.message
                            : String(error),
                        );
                      });
                    }
                  : undefined
              }
            />
          ) : (
            <Lobby
              producer={!!producer}
              name={name}
              onName={setName}
              headphonesOk={headphonesOk}
              onHeadphones={setHeadphonesOk}
              deviceId={deviceId}
              onDeviceId={setDeviceId}
              onJoinProducer={() => setProducerJoined(true)}
              onAccept={() => send("Consent", { accepted: true })}
              onDecline={() => send("Consent", { accepted: false })}
              showMic={!!me && error !== "room_full"}
              stream={mic.stream}
              devices={mic.devices}
              micError={mic.error}
              settingsWarning={mic.settingsWarning}
              permission={mic.status}
              onAllowMic={mic.request}
              onRetryMic={mic.retry}
              deviceLocked={
                snapshot?.state === "recording" || snapshot?.state === "paused"
              }
              roomToneStatus={roomTone.status}
              roomToneError={roomTone.error}
              onRecordRoomTone={roomTone.record}
              onSkipRoomTone={roomTone.skip}
              onRetryRoomTone={roomTone.retry}
              roomToneReady={!bootstrap.build.upload || roomTone.ready}
              roomToneCaptureReady={roomTone.captureReady}
              showRoomTone={!!bootstrap.build.upload}
            />
          )}
        </FocusPull>
      </div>
    </main>
  );
}
