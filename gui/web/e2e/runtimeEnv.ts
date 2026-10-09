import os from "node:os";
import path from "node:path";
import { ownedE2eManifestDirectory } from "./cleanupManifest";

type Environment = NodeJS.ProcessEnv;

export function e2eAuthStores(directory: string) {
  return {
    directory,
    shareRegistry: path.join(directory, "share_registry.sqlite"),
    shareIdentity: path.join(directory, "share_identity.sqlite"),
  };
}

export function ownedE2eAuthStores(manifestPath: string) {
  return e2eAuthStores(ownedE2eManifestDirectory(manifestPath));
}

/**
 * Remove developer deployment settings before launching an E2E GUI server.
 */
export function e2eRuntimeEnv(
  env: Environment,
  invocationId: string,
): Environment {
  const manifest = env.DAW_E2E_CLEANUP_MANIFEST;
  if (!manifest) throw new Error("E2E cleanup manifest is required");
  const stores = ownedE2eAuthStores(manifest);
  const isolated = { ...env };
  for (const name of Object.keys(isolated)) {
    if (
      name.startsWith("PODCAST_RELAY_") ||
      name.startsWith("PODCAST_OBJECT_STORE_")
    ) {
      delete isolated[name];
    }
  }
  delete isolated.PODCAST_EDITING_BIND_REQUEST;
  const relayConfig = path.join(
    os.tmpdir(),
    `sharecut-e2e-relay-${invocationId}.yaml`,
  );
  return {
    ...isolated,
    PODCAST_RELAY_CONFIG: relayConfig,
    PODCAST_SHARE_REGISTRY: stores.shareRegistry,
    PODCAST_SHARE_IDENTITY: stores.shareIdentity,
    ...(env.UX_DEMO_SCREENSHOTS
      ? {
          UX_DEMO_GUEST_TOKENS: path.join(
            stores.directory,
            "guest-tokens.json",
          ),
        }
      : {}),
  };
}
