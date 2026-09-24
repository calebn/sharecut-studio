/** Reject record test hooks in ordinary and release asset bundles. */

import type { Plugin } from "vite";

const E2E_MARKERS = ["__SHARECUT_E2E", "__recordSignalCount"];

export function forbiddenE2eMarker(text: string): string | undefined {
  return E2E_MARKERS.find((marker) => text.includes(marker));
}

export function forbidE2eHooks(): Plugin {
  return {
    name: "sharecut-forbid-e2e-hooks",
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        const text = output.type === "chunk" ? output.code : output.source;
        const marker = forbiddenE2eMarker(String(text));
        if (marker) {
          this.error(
            `Production bundle ${fileName} includes E2E hook ${marker}`,
          );
        }
      }
    },
  };
}
