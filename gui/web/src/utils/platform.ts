/** Apple platforms show ⌘-style shortcuts; everything else uses Ctrl+. */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const hinted = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData?.platform;
  return /mac|iphone|ipad|ipod/i.test(hinted ?? navigator.platform ?? "");
}
