import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { e2eBaseURL, repoRoot } from "../e2e/env";
import { revokeLink, withSharedProject } from "../e2e/guestLink";
import { expectPlaybackAdvancesThenHolds } from "../e2e/playback";
import { openGuestShare } from "../e2e/shareNavigation";

const appOrigin = e2eBaseURL;
const bucket = "sharecut-cors-proof";
const accessKey = "sharecut-test-access";
const secretKey = "sharecut-test-secret";
const relayConfig = process.env.DAW_E2E_CORS_RELAY_CONFIG;
const manifestPath = (token: string) =>
  `/api/review/${token}/daw/proxy/manifest`;

type Track = { hash: string; urls: string[] };
type Manifest = {
  project_basis: unknown;
  tracks: Record<string, Track>;
  object_store_cors?: { status: string; origin: string };
};

function runS3Python(script: string, args: string[]): string {
  const python = `${repoRoot}/.venv/bin/python`;
  const result = spawnSync(python, ["-c", script, ...args], {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`local S3 setup failed with exit ${result.status}`);
  }
  return result.stdout.trim();
}

function ensureBucket(): void {
  runS3Python(
    `import sys, boto3
from botocore.client import Config
from botocore.exceptions import ClientError
endpoint, bucket, key, secret = sys.argv[1:]
s3 = boto3.client('s3', endpoint_url=endpoint, region_name='us-east-1', aws_access_key_id=key, aws_secret_access_key=secret, config=Config(signature_version='s3v4'))
try:
    s3.head_bucket(Bucket=bucket)
except ClientError as error:
    if error.response['ResponseMetadata']['HTTPStatusCode'] != 404:
        raise
    s3.create_bucket(Bucket=bucket)
`,
    ["http://127.0.0.1:18333", bucket, accessKey, secretKey],
  );
}

function setCors(allowedOrigin: string): void {
  runS3Python(
    `import sys, boto3
from botocore.client import Config
endpoint, bucket, key, secret, origin = sys.argv[1:]
s3 = boto3.client('s3', endpoint_url=endpoint, region_name='us-east-1', aws_access_key_id=key, aws_secret_access_key=secret, config=Config(signature_version='s3v4'))
s3.put_bucket_cors(Bucket=bucket, CORSConfiguration={'CORSRules':[{'AllowedOrigins':[origin], 'AllowedMethods':['GET','HEAD'], 'AllowedHeaders':['Range','*'], 'ExposeHeaders':['Content-Range','Content-Length','Accept-Ranges']}]})
`,
    ["http://127.0.0.1:18333", bucket, accessKey, secretKey, allowedOrigin],
  );
}

function setStoreEndpoint(endpoint: string): void {
  if (!relayConfig) throw new Error("private relay config path is missing");
  fs.writeFileSync(
    relayConfig,
    `public_base_url: ${appOrigin}\nobject_store:\n  endpoint_url: ${endpoint}\n  region: us-east-1\n  bucket: ${bucket}\n  access_key_id: ${accessKey}\n  secret_access_key: ${secretKey}\n`,
    { mode: 0o600 },
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test.setTimeout(300_000);

test("real S3 CORS probe replaces the signed URL with the same authenticated share chunk", async ({
  browser,
}) => {
  ensureBucket();
  setCors(appOrigin);
  await withSharedProject(
    browser,
    [{ viewport: { width: 1280, height: 800 }, hasTouch: false }],
    ["commenter"],
    async ([host, guest], links, projectPath) => {
      const token = links.commenter;
      const trackRequest = `${manifestPath(token)}`;
      await guest.route(`**${trackRequest}*`, (route) =>
        route.continue({
          headers: {
            ...route.request().headers(),
            "x-sharecut-relayed": "cors-proof",
          },
        }),
      );
      const positiveResponse = guest!.waitForResponse(
        (response) => new URL(response.url()).pathname === trackRequest,
      );
      await openGuestShare(guest!, token);
      const positiveResult = await positiveResponse;
      expect(positiveResult.status()).toBe(200);
      const positive = (await positiveResult.json()) as Manifest;
      const [trackId, positiveTrack] = Object.entries(positive.tracks)[0] ?? [];
      expect(trackId).toBeTruthy();
      expect(positiveTrack?.urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:18333\//);
      expect(positive.object_store_cors).toBeUndefined();
      const signedUrl = positiveTrack!.urls[0]!;
      const browserAllowed = await guest!.evaluate(async (url) => {
        try {
          const response = await fetch(url, {
            mode: "cors",
            cache: "no-store",
          });
          const bytes = await response.arrayBuffer();
          return {
            ok: response.ok,
            status: response.status,
            bytes: bytes.byteLength,
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.name : "unknown",
          };
        }
      }, signedUrl);
      expect(browserAllowed).toMatchObject({ ok: true, status: 200 });

      setCors("http://denied.invalid");
      setStoreEndpoint("http://localhost:18333");
      const deniedResponse = guest!.waitForResponse(
        (response) => new URL(response.url()).pathname === trackRequest,
      );
      await guest!.reload();
      const deniedResult = await deniedResponse;
      expect(deniedResult.status()).toBe(200);
      const denied = (await deniedResult.json()) as Manifest;
      expect(denied.object_store_cors).toEqual({
        status: "blocked",
        origin: appOrigin,
      });
      expect(denied.project_basis).toEqual(positive.project_basis);
      expect(denied.tracks[trackId!]?.hash).toBe(positiveTrack!.hash);
      const localUrl = denied.tracks[trackId!]!.urls[0]!;
      expect(localUrl).toMatch(
        new RegExp(
          `^/api/review/${token}/daw/proxy/${trackId}/${positiveTrack!.hash}/0$`,
        ),
      );

      const browserDenied = await guest!.evaluate(async (url) => {
        try {
          const response = await fetch(url, {
            mode: "cors",
            cache: "no-store",
          });
          const bytes = await response.arrayBuffer();
          return {
            ok: response.ok,
            status: response.status,
            bytes: bytes.byteLength,
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.name : "unknown",
          };
        }
      }, signedUrl);
      expect(browserDenied).toEqual({ ok: false, error: "TypeError" });

      const signedWithOrigin = await host!.request.get(signedUrl, {
        headers: { Origin: appOrigin, Range: "bytes=0-0" },
      });
      expect(signedWithOrigin.status()).toBe(206);
      expect(
        signedWithOrigin.headers()["access-control-allow-origin"],
      ).toBeUndefined();
      const signedResponse = await host!.request.get(signedUrl);
      expect(signedResponse.status()).toBe(200);
      const localResponse = await host!.request.get(localUrl);
      expect(localResponse.status()).toBe(200);
      expect(sha256(await signedResponse.body())).toBe(
        sha256(await localResponse.body()),
      );

      const finishedLocalChunks = new Set<string>();
      guest!.on("requestfinished", (request) => {
        const url = new URL(request.url());
        if (
          url.pathname.startsWith(`/api/review/${token}/daw/proxy/`) &&
          url.pathname !== trackRequest
        ) {
          finishedLocalChunks.add(url.pathname);
        }
      });
      await expectPlaybackAdvancesThenHolds(guest!);
      expect(finishedLocalChunks.has(localUrl)).toBe(true);

      await revokeLink(host!, token, projectPath);
      const afterRevoke = await host!.request.get(localUrl);
      expect([401, 403, 404]).toContain(afterRevoke.status());
      expect(sha256(await afterRevoke.body())).not.toBe(
        sha256(await localResponse.body()),
      );
      process.stdout.write(
        `${JSON.stringify({
          positive: "signed URL returned and browser GET succeeded",
          negative:
            "real signed GET returned 206 without ACAO; browser fetch rejected with TypeError",
          fallback:
            "same accepted basis and proxy hash served by authenticated share URL; byte hashes matched",
          playback: "player clock advanced and local chunk request completed",
          permission: `revoked token returned ${afterRevoke.status()} with no media bytes`,
        })}\n`,
      );
    },
  );
});

test("direct loopback review audio plays with a real S3-backed share", async ({
  browser,
}) => {
  ensureBucket();
  setStoreEndpoint("http://127.0.0.1:18333");
  setCors(appOrigin);
  await withSharedProject(
    browser,
    [{ viewport: { width: 1280, height: 800 } }],
    ["commenter"],
    async ([host, guest], links, projectPath) => {
      const token = links.commenter;
      const audioPath = `/api/review/${token}/audio`;
      let mediaCspBlocked = false;
      guest!.on("console", (message) => {
        if (message.text().includes("media-src")) mediaCspBlocked = true;
      });
      try {
        await openGuestShare(guest!, token);
        const direct = await guest!.request.get(audioPath, {
          maxRedirects: 0,
        });
        const loaded = await guest!.evaluate(async (source) => {
          const media = document.createElement("audio");
          media.muted = true;
          try {
            media.src = source;
            await media.play();
            return media.duration > 0;
          } catch {
            return false;
          } finally {
            media.pause();
            media.removeAttribute("src");
            media.load();
          }
        }, audioPath);
        expect({ status: direct.status(), loaded, mediaCspBlocked }).toEqual({
          status: 200,
          loaded: true,
          mediaCspBlocked: false,
        });

        const relayed = await guest!.request.get(audioPath, {
          headers: { "x-sharecut-relayed": "1" },
          maxRedirects: 0,
        });
        expect(relayed.status()).toBe(302);
        const signedUrl = new URL(relayed.headers().location!);
        expect(signedUrl.origin).toBe("http://127.0.0.1:18333");
        const signed = await guest!.request.get(signedUrl.href);
        expect(signed.status()).toBe(200);
        expect(sha256(await direct.body())).toBe(sha256(await signed.body()));
      } finally {
        await revokeLink(host!, token, projectPath);
      }
      const revoked = await guest!.request.get(audioPath, { maxRedirects: 0 });
      expect(revoked.status()).toBe(404);
    },
  );
});
