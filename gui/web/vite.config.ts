import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export function shouldInlineAsset(filePath: string, content: Buffer): boolean {
  if (/\b(?:keeperProcessor|inputMeterProcessor)\.js$/.test(filePath)) {
    return false;
  }
  return content.length < 4096;
}

export default defineConfig({
  // Relative base so lazy chunks/CSS resolve under /r/{token}/ (with <base href>),
  // not the public origin root /assets/*.
  base: "./",
  plugins: [react()],
  build: {
    assetsInlineLimit: shouldInlineAsset,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8765",
        changeOrigin: true,
      },
    },
  },
});
