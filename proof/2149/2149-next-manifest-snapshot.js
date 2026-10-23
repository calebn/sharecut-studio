(() => {
  let topLevel;
  let topOrigin;
  try { topLevel = window.top === window; topOrigin = window.top.location.origin; }
  catch { topLevel = false; topOrigin = "cross-origin unreadable"; }
  const scripts = [...document.scripts].map((s) => ({ src: s.src, type: s.type,
    async: s.async, defer: s.defer, integrity: s.integrity,
    inlineText: s.src ? null : s.textContent }));
  return { capturedAt: new Date().toISOString(), href: location.href, origin: location.origin,
    protocol: location.protocol, baseURI: document.baseURI, topLevel, topOrigin,
    frameElement: window.frameElement?.localName || null, contentType: document.contentType,
    compatMode: document.compatMode, characterSet: document.characterSet, readyState: document.readyState,
    viewportMetas: [...document.querySelectorAll('meta[name="viewport" i]')].map((m) => m.outerHTML),
    baseElements: [...document.querySelectorAll("base")].map((b) => b.outerHTML), scripts,
    stylesheets: [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => ({ href: l.href, integrity: l.integrity })),
    loadedResources: performance.getEntriesByType("resource").map((r) => ({ name: r.name,
      initiatorType: r.initiatorType, transferSize: r.transferSize, decodedBodySize: r.decodedBodySize })),
    domOuterHTML: document.documentElement.outerHTML,
    gateMetadata: window.__sharecut2149Gate?.export().metadata || null,
    probeMetadata: window.__sharecut2149Probe?.export().metadata || null,
    limitation: "DOM and resource URLs are not raw HTTP response bytes or asset hashes; capture and hash those independently on the existing QA host." };
})();
