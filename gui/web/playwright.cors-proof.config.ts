import fs from "node:fs";
import path from "node:path";
import { ownedE2eManifestDirectory } from "./e2e/cleanupManifest";
import { e2eBaseURL, e2ePort, repoRoot } from "./e2e/env";
import { e2eRuntimeEnv } from "./e2e/runtimeEnv";
import base from "./playwright.config";

const manifestPath = process.env.DAW_E2E_CLEANUP_MANIFEST;
if (!manifestPath) throw new Error("E2E cleanup manifest is required");
const directory = ownedE2eManifestDirectory(manifestPath);
const relayConfig = path.join(directory, "real-store-cors.yaml");
const env = e2eRuntimeEnv(process.env, `${process.pid}-${e2ePort}`);
const baseConfig = Array.isArray(base) ? base[0]! : base;
const configYaml = (endpoint: string) =>
  `public_base_url: ${e2eBaseURL}\nobject_store:\n  endpoint_url: ${endpoint}\n  region: us-east-1\n  bucket: sharecut-cors-proof\n  access_key_id: sharecut-test-access\n  secret_access_key: sharecut-test-secret\n`;
fs.writeFileSync(relayConfig, configYaml("http://127.0.0.1:18333"), {
  mode: 0o600,
});
env.PODCAST_RELAY_CONFIG = relayConfig;
env.DAW_E2E_CORS_RELAY_CONFIG = relayConfig;
process.env.DAW_E2E_CORS_RELAY_CONFIG = relayConfig;

export default {
  ...baseConfig,
  testDir: "./e2e-real-store",
  testMatch: "guest-s3-cors-proof.spec.ts",
  webServer: {
    ...baseConfig.webServer,
    command: `uv run --extra gui podcast gui --host 127.0.0.1 --port ${e2ePort} --no-open`,
    cwd: repoRoot,
    env,
    reuseExistingServer: false,
  },
};
