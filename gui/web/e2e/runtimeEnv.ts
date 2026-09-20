import os from "node:os";
import path from "node:path";

type Environment = NodeJS.ProcessEnv;

/**
 * Remove developer deployment settings before launching an E2E GUI server.
 */
export function e2eRuntimeEnv(
  env: Environment,
  invocationId: string,
): Environment {
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
  };
}
