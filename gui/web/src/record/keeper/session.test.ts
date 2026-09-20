import { describe, expect, it } from "vitest";
import { parseWavHeader, wavPcmToFloat32 } from "../../audio/wavHeader";
import { KEEPER_SAMPLE_RATE } from "./pcm";
import { KeeperSession } from "./session";
import { keeperWavPath, MemorySink } from "./store";

const ids = { sessionId: "cool-room", participantId: "p_g" };

function tone(
  hz: number,
  seconds: number,
  rate = KEEPER_SAMPLE_RATE,
): Float32Array {
  const n = Math.floor(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.sin((2 * Math.PI * hz * i) / rate);
  }
  return out;
}

describe("KeeperSession", () => {
  it("writes no bytes until recording after consent", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    await session.apply({
      ...ids,
      role: "guest",
      consented: true,
      roomState: "lobby",
      takeIndex: -1,
      recordingMs: 0,
      muted: false,
    });
    session.push(tone(220, 0.05), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(sink.files.size).toBe(0);
  });

  it("encodes a 48 kHz 16-bit mono WAV for a recording segment", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    await session.apply({
      ...ids,
      role: "guest",
      consented: true,
      roomState: "recording",
      takeIndex: 0,
      recordingMs: 0,
      muted: false,
    });
    session.push(tone(220, 0.1), KEEPER_SAMPLE_RATE);
    await session.flush();
    const wavPath = keeperWavPath({
      sessionId: ids.sessionId,
      takeIndex: 0,
      participantId: ids.participantId,
      segmentIndex: 0,
    });
    const growing = sink.files.get(wavPath);
    expect(growing?.byteLength).toBeGreaterThan(44);
    await session.dispose();
    const wav = sink.files.get(wavPath);
    expect(wav).toBeTruthy();
    const header = parseWavHeader(wav!.buffer);
    expect(header.sampleRate).toBe(48000);
    expect(header.channels).toBe(1);
    expect(header.bitsPerSample).toBe(16);
    expect(session.files[0]?.samplesWritten).toBeGreaterThan(4000);
  });

  it("writes zeros for a muted span without shortening the file", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    const live = {
      ...ids,
      role: "guest" as const,
      consented: true as const,
      roomState: "recording" as const,
      takeIndex: 0,
      recordingMs: 0,
      muted: false,
    };
    await session.apply(live);
    session.push(tone(440, 0.05), KEEPER_SAMPLE_RATE);
    await session.apply({ ...live, muted: true });
    session.push(tone(440, 0.05), KEEPER_SAMPLE_RATE);
    await session.dispose();
    const wavPath = keeperWavPath({
      sessionId: ids.sessionId,
      takeIndex: 0,
      participantId: ids.participantId,
      segmentIndex: 0,
    });
    const wav = sink.files.get(wavPath);
    expect(wav).toBeTruthy();
    const header = parseWavHeader(wav!.buffer);
    const peak = wavPcmToFloat32(wav!.buffer.slice(header.dataOffset), header);
    const half = Math.floor(peak.length / 2);
    const livePeak = Math.max(...peak.subarray(0, half));
    const mutePeak = Math.max(...peak.subarray(half));
    expect(livePeak).toBeGreaterThan(0.5);
    expect(mutePeak).toBe(0);
  });

  it("writes nothing during pause and opens a second segment on resume", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    const base = {
      ...ids,
      role: "guest" as const,
      consented: true as const,
      takeIndex: 0,
      muted: false,
    };
    await session.apply({ ...base, roomState: "recording", recordingMs: 0 });
    session.push(tone(220, 0.02), KEEPER_SAMPLE_RATE);
    await session.apply({ ...base, roomState: "paused", recordingMs: 20 });
    const afterPause = sink.files.size;
    session.push(tone(220, 0.1), KEEPER_SAMPLE_RATE);
    expect(sink.files.size).toBe(afterPause);
    await session.apply({
      ...base,
      roomState: "recording",
      recordingMs: 20,
    });
    session.push(tone(880, 0.02), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(session.files.map((f) => f.segmentIndex)).toEqual([0, 1]);
    expect(session.files[1]?.joinOffsetMs).toBe(20);
  });

  it("never writes for a producer", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    await session.apply({
      sessionId: "cool-room",
      participantId: "p_prod",
      role: "producer",
      consented: null,
      roomState: "recording",
      takeIndex: 0,
      recordingMs: 0,
      muted: false,
    });
    session.push(tone(220, 0.05), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(sink.files.size).toBe(0);
  });

  it("serializes overlapping apply calls", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    const live = {
      ...ids,
      role: "guest" as const,
      consented: true as const,
      roomState: "recording" as const,
      takeIndex: 0,
      recordingMs: 0,
      muted: false,
    };
    const first = session.apply(live);
    const second = session.apply({ ...live, muted: true });
    await Promise.all([first, second]);
    session.push(tone(440, 0.02), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(session.files).toHaveLength(1);
  });

  it("resumes segment indexes from existing sink files", async () => {
    const sink = new MemorySink();
    const first = new KeeperSession(sink);
    await first.apply({
      ...ids,
      role: "guest",
      consented: true,
      roomState: "recording",
      takeIndex: 0,
      recordingMs: 0,
      muted: false,
    });
    first.push(tone(220, 0.02), KEEPER_SAMPLE_RATE);
    await first.dispose();
    const second = new KeeperSession(sink);
    await second.restoreCursor(ids.sessionId, 0, ids.participantId);
    await second.apply({
      ...ids,
      role: "guest",
      consented: true,
      roomState: "recording",
      takeIndex: 0,
      recordingMs: 20,
      muted: false,
    });
    second.push(tone(880, 0.02), KEEPER_SAMPLE_RATE);
    await second.dispose();
    expect(second.files.map((f) => f.segmentIndex)).toEqual([1]);
  });
});
