import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createE2eCleanupManifest,
  type E2eCleanupManifest,
  ownedE2eManifestDirectory,
} from "./cleanupManifest";
import { e2eRuntimeEnv } from "./runtimeEnv";

describe("e2eRuntimeEnv", () => {
  let manifest: E2eCleanupManifest;
  beforeEach(() => {
    manifest = createE2eCleanupManifest();
  });
  afterEach(() => {
    fs.rmSync(manifest.manifestDir, { recursive: true, force: true });
  });
  it("removes every relay and object-store deployment setting", () => {
    const env = e2eRuntimeEnv(
      {
        DAW_E2E_CLEANUP_MANIFEST: manifest.manifestPath,
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
        DAW_E2E_CLEANUP_MANIFEST: manifest.manifestPath,
        PODCAST_RELAY_CONFIG: "/tmp/developer-relay.yaml",
        PODCAST_E2E_RELAY_CONFIG: "/tmp/unsupported-override.yaml",
      },
      "test-run",
    );
    expect(env.PODCAST_RELAY_CONFIG).toBe(
      path.join(os.tmpdir(), "sharecut-e2e-relay-test-run.yaml"),
    );
  });

  it("derives auth stores from the physical directory of a validated invocation manifest", () => {
    const physical = fs.realpathSync(manifest.manifestDir);
    const env = e2eRuntimeEnv(
      {
        DAW_E2E_CLEANUP_MANIFEST: manifest.manifestPath,
        PODCAST_SHARE_REGISTRY: "/host/registry.sqlite",
        PODCAST_SHARE_IDENTITY: "/host/identity.sqlite",
        UX_DEMO_SCREENSHOTS: "1",
      },
      "physical-owner",
    );

    expect(ownedE2eManifestDirectory(manifest.manifestPath)).toBe(physical);
    expect(env.PODCAST_SHARE_REGISTRY).toBe(
      path.join(physical, "share_registry.sqlite"),
    );
    expect(env.PODCAST_SHARE_IDENTITY).toBe(
      path.join(physical, "share_identity.sqlite"),
    );
    expect(env.UX_DEMO_GUEST_TOKENS).toBe(
      path.join(physical, "guest-tokens.json"),
    );
  });

  it("refuses invalid invocation metadata before choosing auth paths", () => {
    const host = fs.mkdtempSync(
      path.join(os.tmpdir(), "sharecut-e2e-host-sentinel-"),
    );
    const registry = path.join(host, "registry.sqlite");
    const identity = path.join(host, "identity.sqlite");
    fs.writeFileSync(registry, "host registry sentinel");
    fs.writeFileSync(identity, "host identity sentinel");
    const invalidManifest = '{"workspaces":[17]}\n';
    fs.writeFileSync(manifest.manifestPath, invalidManifest);

    try {
      expect(() =>
        e2eRuntimeEnv(
          {
            DAW_E2E_CLEANUP_MANIFEST: manifest.manifestPath,
            PODCAST_SHARE_REGISTRY: registry,
            PODCAST_SHARE_IDENTITY: identity,
            UX_DEMO_SCREENSHOTS: "1",
          },
          "invalid-owner",
        ),
      ).toThrow("E2E cleanup manifest is invalid");

      expect(fs.readFileSync(registry, "utf8")).toBe("host registry sentinel");
      expect(fs.readFileSync(identity, "utf8")).toBe("host identity sentinel");
      expect(fs.readFileSync(manifest.manifestPath, "utf8")).toBe(
        invalidManifest,
      );
    } finally {
      fs.rmSync(host, { recursive: true, force: true });
    }
  });
});
