import os from "node:os";
import path from "node:path";
import { ownedE2eManifestDirectory } from "./cleanupManifest";

type Environment = NodeJS.ProcessEnv;

/**
 * Remove developer deployment settings before launching an E2E GUI server.
 */
export function e2eRuntimeEnv(
  env: Environment,
  invocationId: string,
): Environment {
  const manifest = env.DAW_E2E_CLEANUP_MANIFEST;
  if (!manifest) throw new Error("E2E cleanup manifest is required");
  const directory = ownedE2eManifestDirectory(manifest);
  const isolated = { ...env };
  for (const name of Object.keys(isolated)) {
    if (
      name.startsWith("PODCAST_RELAY_") ||
      name.startsWith("PODCAST_OBJECT_STORE_")
    ) {
      delete isolated[name];
    }
  }
  const relayConfig = path.join(
    os.tmpdir(),
    `sharecut-e2e-relay-${invocationId}.yaml`,
  );
  return {
    ...isolated,
    PODCAST_RELAY_CONFIG: relayConfig,
    PODCAST_SHARE_REGISTRY: path.join(directory, "share_registry.sqlite"),
    PODCAST_SHARE_IDENTITY: path.join(directory, "share_identity.sqlite"),
    ...(env.UX_DEMO_SCREENSHOTS
      ? { UX_DEMO_GUEST_TOKENS: path.join(directory, "guest-tokens.json") }
      : {}),
  };
}
