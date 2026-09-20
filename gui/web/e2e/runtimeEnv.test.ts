import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { e2eRuntimeEnv } from "./runtimeEnv";

describe("e2eRuntimeEnv", () => {
  it("removes every relay and object-store deployment setting", () => {
    const env = e2eRuntimeEnv(
      {
        PODCAST_RELAY_CONFIG: "/Users/developer/.config/podcast_mcp/relay.yaml",
        PODCAST_RELAY_URL: "https://relay.example.test",
        PODCAST_RELAY_HOST_TOKEN: "relay-secret",
        PODCAST_RELAY_PUBLIC_BASE_URL: "https://share.example.test",
        PODCAST_RELAY_LOCAL_GUI_URL: "http://127.0.0.1:8766",
        PODCAST_OBJECT_STORE_ENDPOINT_URL: "https://objects.example.test",
        PODCAST_OBJECT_STORE_REGION: "region",
        PODCAST_OBJECT_STORE_ACCESS_KEY_ID: "private-key",
        PODCAST_OBJECT_STORE_SECRET_ACCESS_KEY: "private-secret",
        PODCAST_OBJECT_STORE_BUCKET: "production",
        PODCAST_OBJECT_STORE_CDN_ENDPOINT: "https://cdn.example.test",
      },
      "test-run",
    );

    expect(env.PODCAST_RELAY_CONFIG).toBe(
      path.join(os.tmpdir(), "sharecut-e2e-relay-test-run.yaml"),
    );
    for (const name of [
      "PODCAST_RELAY_URL",
      "PODCAST_RELAY_HOST_TOKEN",
      "PODCAST_RELAY_PUBLIC_BASE_URL",
      "PODCAST_RELAY_LOCAL_GUI_URL",
      "PODCAST_OBJECT_STORE_ENDPOINT_URL",
      "PODCAST_OBJECT_STORE_REGION",
      "PODCAST_OBJECT_STORE_ACCESS_KEY_ID",
      "PODCAST_OBJECT_STORE_SECRET_ACCESS_KEY",
      "PODCAST_OBJECT_STORE_BUCKET",
      "PODCAST_OBJECT_STORE_CDN_ENDPOINT",
    ]) {
      expect(env[name]).toBeUndefined();
    }
  });

  it("does not allow a developer relay config to override isolation", () => {
    const env = e2eRuntimeEnv(
      {
        PODCAST_RELAY_CONFIG: "/tmp/developer-relay.yaml",
        PODCAST_E2E_RELAY_CONFIG: "/tmp/unsupported-override.yaml",
      },
      "test-run",
    );
    expect(env.PODCAST_RELAY_CONFIG).toBe(
      path.join(os.tmpdir(), "sharecut-e2e-relay-test-run.yaml"),
    );
  });
});
