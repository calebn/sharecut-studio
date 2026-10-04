import { createHash } from "node:crypto";
import { type CDPSession, expect, type Page } from "@playwright/test";
import type { InteractionReceipt } from "./interactionEvidence";

export type NativeEnvelopeMedia = {
  time: number;
  paused: boolean;
  ready: number;
  ended: boolean;
  error: number | null;
  volume: number;
  muted: boolean;
  rate: number;
  duration: number | null;
  kind: string;
  trackId: string;
  version: string | null;
};
function failNativeMediaProtocol(
  receipts: InteractionReceipt[],
  phase: string,
  details: {
    text: string;
    lineNumber: number;
    columnNumber: number;
    exception?: { className?: string; description?: string };
    stackTrace?: {
      callFrames: {
        functionName: string;
        lineNumber: number;
        columnNumber: number;
      }[];
    };
  },
): never {
  const redact = (text: string) =>
    text
      .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[redacted URL]")
      .replace(/\?[^\s"'<>]+/g, "?[redacted query]");
  const evidence = {
    phase,
    text: redact(details.text),
    className: details.exception?.className,
    description: details.exception?.description
      ? redact(details.exception.description)
      : undefined,
    lineNumber: details.lineNumber,
    columnNumber: details.columnNumber,
    stack: details.stackTrace?.callFrames.map((frame) => ({
      functionName: redact(frame.functionName),
      lineNumber: frame.lineNumber,
      columnNumber: frame.columnNumber,
    })),
  };
  receipts.push({
    checkpoint: "native-media-protocol-exception",
    observation: evidence,
  });
  throw new Error(`Native media ${phase} failed: ${JSON.stringify(evidence)}`);
}

async function captureNativeMedia(
  session: CDPSession,
  projectPath: string,
  trackId: string,
  receipts: InteractionReceipt[],
): Promise<string | undefined> {
  const prototype = await session.send("Runtime.evaluate", {
    expression: "HTMLAudioElement.prototype",
    objectGroup: "envelope-native-media",
  });
  if (!prototype.result.objectId)
    throw new Error("Native HTMLAudioElement prototype unavailable");
  const instances = await session.send("Runtime.queryObjects", {
    prototypeObjectId: prototype.result.objectId,
    objectGroup: "envelope-native-media",
  });
  const result = await session.send("Runtime.callFunctionOn", {
    objectId: instances.objects.objectId,
    arguments: [{ value: projectPath }, { value: trackId }],
    returnByValue: false,
    functionDeclaration: `function(projectPath, trackId) {
      return Array.from(this).find((media) => {
        if (!media.currentSrc || media.paused || media.muted || media.volume <= 0 || media.readyState < 2 || media.error) return false;
        const url = new URL(media.currentSrc, location.href);
        return url.pathname === '/api/audio' && url.searchParams.get('path') === projectPath && url.searchParams.get('track_id') === trackId && url.searchParams.get('kind') === 'stem';
      });
    }`,
  });
  if (result.exceptionDetails)
    failNativeMediaProtocol(receipts, "capture", result.exceptionDetails);
  return result.result.objectId;
}
async function sampleNativeMedia(
  session: CDPSession,
  objectId: string,
  receipts: InteractionReceipt[],
): Promise<NativeEnvelopeMedia> {
  const result = await session.send("Runtime.callFunctionOn", {
    objectId,
    returnByValue: true,
    functionDeclaration: `function() {
      const url = new URL(this.currentSrc, location.href);
      return {time: this.currentTime, paused: this.paused, ready: this.readyState, ended: this.ended, error: this.error?.code ?? null, volume: this.volume, muted: this.muted, rate: this.playbackRate, duration: Number.isFinite(this.duration) ? this.duration : null, kind: url.searchParams.get('kind'), trackId: url.searchParams.get('track_id'), version: url.searchParams.get('v')};
    }`,
  });
  if (result.exceptionDetails)
    failNativeMediaProtocol(receipts, "sampling", result.exceptionDetails);
  return result.result.value as NativeEnvelopeMedia;
}
async function releaseMediaSession(session: CDPSession, primary: unknown) {
  const results = await Promise.allSettled([
    session.send("Runtime.releaseObjectGroup", {
      objectGroup: "envelope-native-media",
    }),
  ]);
  const detached = await session.detach().then(
    () => null,
    (error: unknown) => error,
  );
  if (primary !== undefined) return;
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  if (detached != null) throw detached;
}

async function observeNativeStemBytes(
  session: CDPSession,
  projectPath: string,
  trackId: string,
) {
  let requestId: string | undefined;
  let responseURL: string | undefined;
  let headers: Record<string, string> = {};
  let status: number | undefined;
  let buffered = Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let streamState: "waiting" | "pending" | "ready" | "failed" = "waiting";
  let streamError: string | null = null;
  let missingData = false;
  let finished = false;
  let failure: { canceled: boolean; error: string } | null = null;
  const bytes = () => Buffer.concat([buffered, ...chunks]);
  const responseReceived = (event: {
    requestId: string;
    response: { url: string; status: number; headers: Record<string, string> };
  }) => {
    const url = new URL(event.response.url);
    if (
      requestId ||
      url.pathname !== "/api/audio" ||
      url.searchParams.get("path") !== projectPath ||
      url.searchParams.get("track_id") !== trackId ||
      url.searchParams.get("kind") !== "stem"
    )
      return;
    requestId = event.requestId;
    responseURL = event.response.url;
    status = event.response.status;
    headers = Object.fromEntries(
      Object.entries(event.response.headers).map(([key, value]) => [
        key.toLowerCase(),
        String(value),
      ]),
    );
    streamState = "pending";
    void session.send("Network.streamResourceContent", { requestId }).then(
      (result) => {
        buffered = Buffer.from(result.bufferedData, "base64");
        streamState = "ready";
      },
      () => {
        streamState = "failed";
        streamError =
          "Network.streamResourceContent rejected; native byte capture unavailable";
      },
    );
  };
  const dataReceived = (event: {
    requestId: string;
    dataLength: number;
    data?: string;
  }) => {
    if (event.requestId !== requestId) return;
    if (event.data !== undefined) {
      const chunk = Buffer.from(event.data, "base64");
      if (chunk.length !== event.dataLength) missingData = true;
      chunks.push(chunk);
    } else if (
      event.dataLength > 0 &&
      (streamState === "ready" || chunks.length > 0)
    )
      missingData = true;
  };
  const loadingFinished = (event: { requestId: string }) => {
    if (event.requestId === requestId) finished = true;
  };
  const loadingFailed = (event: {
    requestId: string;
    canceled?: boolean;
    errorText: string;
  }) => {
    if (event.requestId === requestId)
      failure = { canceled: event.canceled === true, error: event.errorText };
  };
  session.on("Network.responseReceived", responseReceived);
  session.on("Network.dataReceived", dataReceived);
  session.on("Network.loadingFinished", loadingFinished);
  session.on("Network.loadingFailed", loadingFailed);
  const dispose = () => {
    session.off("Network.responseReceived", responseReceived);
    session.off("Network.dataReceived", dataReceived);
    session.off("Network.loadingFinished", loadingFinished);
    session.off("Network.loadingFailed", loadingFailed);
  };
  try {
    await session.send("Network.enable");
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    dispose,
    bytes,
    url: () => responseURL,
    async ready() {
      await expect.poll(() => streamState).toMatch(/ready|failed/);
      expect(streamState, streamError ?? "CDP streaming must activate").toBe(
        "ready",
      );
      expect([200, 206]).toContain(status);
      expect(headers["content-type"]).toMatch(/audio\//);
      expect(headers["content-encoding"] ?? "identity").toBe("identity");
      if (status === 206)
        expect(headers["content-range"]).toMatch(/^bytes 0-\d+\/\d+$/);
      await expect.poll(() => bytes().length).toBeGreaterThan(44);
      expect(missingData).toBe(false);
    },
    snapshot() {
      const url = responseURL ? new URL(responseURL) : null;
      const delivered = bytes();
      return {
        requestId,
        streamState,
        streamError,
        missingData,
        finished,
        failure,
        route: url
          ? {
              path: url.pathname,
              kind: url.searchParams.get("kind"),
              trackId: url.searchParams.get("track_id"),
              version: url.searchParams.get("v"),
              rerender: url.searchParams.get("rerender"),
            }
          : null,
        status,
        contentType: headers["content-type"],
        contentRange: headers["content-range"] ?? null,
        bufferedBytes: buffered.length,
        liveChunkLengths: chunks.map((chunk) => chunk.length),
        prefixBytes: delivered.length,
        prefixSha256: createHash("sha256").update(delivered).digest("hex"),
      };
    },
  };
}

export async function proveHostEnvelopePlayback(
  page: Page,
  projectPath: string,
  trackId: string,
  receipts: InteractionReceipt[],
) {
  const session = await page.context().newCDPSession(page);
  let primary: unknown;
  let stream: Awaited<ReturnType<typeof observeNativeStemBytes>> | undefined;
  let phase = "arm-network-observer";
  let nativeBefore: NativeEnvelopeMedia | undefined;
  let nativeAfter: NativeEnvelopeMedia | undefined;
  try {
    stream = await observeNativeStemBytes(session, projectPath, trackId);
    const pending = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/audio" &&
        url.searchParams.get("path") === projectPath &&
        url.searchParams.get("track_id") === trackId &&
        url.searchParams.get("kind") === "stem"
      );
    });
    const [, response] = await Promise.all([
      page.getByRole("button", { name: "Edited stems", exact: true }).click(),
      pending,
    ]);
    expect([200, 206]).toContain(response.status());
    expect(response.headers()["content-type"]).toMatch(/audio\//);
    const url = new URL(response.url());
    expect(url.searchParams.get("v")).toEqual(expect.stringMatching(/\S/));
    phase = "capture-native-delivered-prefix";
    await stream.ready();
    expect(stream.url()).toBe(response.url());
    phase = "native-media-playback";
    await page.getByRole("button", { name: "Play", exact: true }).click();
    let mediaObject: string | undefined;
    await expect
      .poll(async () => {
        mediaObject = await captureNativeMedia(
          session,
          projectPath,
          trackId,
          receipts,
        );
        return mediaObject != null;
      })
      .toBe(true);
    const before = await sampleNativeMedia(session, mediaObject!, receipts);
    nativeBefore = before;
    expect(before.version).toBe(url.searchParams.get("v"));
    let after = before;
    await expect
      .poll(async () => {
        after = await sampleNativeMedia(session, mediaObject!, receipts);
        return (
          !after.paused &&
          after.version === before.version &&
          after.time > before.time + 0.2 &&
          !after.error
        );
      })
      .toBe(true);
    nativeAfter = after;
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    phase = "bind-native-prefix-to-full-resource";
    stream.dispose();
    const delivered = stream.bytes();
    const nativeDelivery = stream.snapshot();
    expect(nativeDelivery.missingData).toBe(false);
    const fullResponse = await page.request.get(response.url(), {
      headers: { Range: "bytes=0-" },
    });
    expect([200, 206]).toContain(fullResponse.status());
    const full = await fullResponse.body();
    if (fullResponse.status() === 206)
      expect(fullResponse.headers()["content-range"]).toBe(
        `bytes 0-${full.length - 1}/${full.length}`,
      );
    const decoded = decodePcm(full);
    expect(delivered.length).toBeGreaterThanOrEqual(
      decoded.dataOffset + decoded.format.block,
    );
    expect(delivered.equals(full.subarray(0, delivered.length))).toBe(true);
    const contentRange = response.headers()["content-range"];
    if (response.status() === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? "");
      expect(range).not.toBeNull();
      expect(Number(range![3])).toBe(full.length);
      expect(Number(range![1])).toBe(0);
      expect(delivered.length).toBeLessThanOrEqual(Number(range![2]) + 1);
    } else expect(delivered.length).toBeLessThanOrEqual(full.length);
    return {
      pcm: full,
      receipt: {
        route: {
          path: url.pathname,
          kind: url.searchParams.get("kind"),
          trackId: url.searchParams.get("track_id"),
          version: url.searchParams.get("v"),
          rerender: url.searchParams.get("rerender"),
        },
        response: {
          status: response.status(),
          contentType: response.headers()["content-type"],
          contentRange: contentRange ?? null,
          deliveredBytes: delivered.length,
          deliveredSha256: createHash("sha256").update(delivered).digest("hex"),
          fullBytes: full.length,
          fullSha256: createHash("sha256").update(full).digest("hex"),
        },
        nativeDelivery,
        mediaObject,
        before,
        after,
        scope:
          "The same actual native HTMLMediaElement, observed contiguous native response prefix and separately fetched matching full resource; not complete native-body capture or heard-audio proof",
      },
    };
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    stream?.dispose();
    receipts.push({
      checkpoint: "native-stem-observer-terminal",
      observation: {
        phase,
        failed: primary !== undefined,
        stream: stream?.snapshot() ?? null,
        nativeBefore,
        nativeAfter,
      },
    });
    await releaseMediaSession(session, primary);
  }
}
function decodePcm(bytes: Buffer) {
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
  let format:
    | {
        tag: number;
        channels: number;
        sampleRate: number;
        bits: number;
        block: number;
      }
    | undefined;
  let data: Buffer | undefined;
  let dataOffset = 0;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const kind = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = bytes.subarray(offset + 8, offset + 8 + size);
    if (kind === "fmt ")
      format = {
        tag:
          body.readUInt16LE(0) === 65534
            ? body.readUInt16LE(24)
            : body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        block: body.readUInt16LE(12),
        bits: body.readUInt16LE(14),
      };
    if (kind === "data") {
      data = body;
      dataOffset = offset + 8;
    }
    offset += 8 + size + (size % 2);
  }
  if (!format || !data)
    throw new Error("Actual stem WAV lacks fmt/data chunks");
  if (!(format.tag === 1 && format.bits === 16))
    throw new Error(
      `PCM comparison requires observed signed16 WAV; got format ${format.tag}/${format.bits}`,
    );
  expect(data.length % format.block).toBe(0);
  return {
    format,
    data,
    dataOffset,
    frames: data.length / format.block,
    quantum: 1 / 32768,
  };
}
export function compareConstantEnvelopePcm(
  unity: Buffer,
  changed: Buffer,
  gain: number,
) {
  const before = decodePcm(unity),
    after = decodePcm(changed);
  expect(after.format).toEqual(before.format);
  expect(after.frames).toBe(before.frames);
  let baselineEnergy = 0,
    candidateEnergy = 0,
    errorEnergy = 0,
    maxError = 0;
  const samples = before.data.length / 2;
  for (let i = 0; i < samples; i++) {
    const a = before.data.readInt16LE(i * 2) / 32768;
    const b = after.data.readInt16LE(i * 2) / 32768;
    const error = b - gain * a;
    baselineEnergy += a * a;
    candidateEnergy += b * b;
    errorEnergy += error * error;
    maxError = Math.max(maxError, Math.abs(error));
  }
  const baselineRms = Math.sqrt(baselineEnergy / samples);
  const candidateRms = Math.sqrt(candidateEnergy / samples);
  const errorRms = Math.sqrt(errorEnergy / samples);
  const quantizationBound = before.quantum * Math.abs(gain) + after.quantum;
  expect(baselineRms).toBeGreaterThan(before.quantum * 100);
  expect(errorRms).toBeLessThanOrEqual(quantizationBound);
  return {
    format: before.format,
    frames: before.frames,
    samples,
    expectedGain: gain,
    baselineRms,
    candidateRms,
    ratio: candidateRms / baselineRms,
    errorRms,
    maxError,
    quantizationBound,
    boundReason:
      "One signed16 quantization step from each observed output, propagated through the known constant multiplier; fixed before runtime, not tuned to result",
  };
}
