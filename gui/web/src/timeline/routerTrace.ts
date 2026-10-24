/// <reference types="vite/client" />
export const ROUTER_TRACE = import.meta.env.VITE_SHARECUT_E2E === "1";

export function describeNode(node: unknown): string | null {
  if (!(node instanceof Element)) return null;
  const kind = node.closest("[data-hit-kind]")?.getAttribute("data-hit-kind");
  const cls = typeof node.className === "string" ? node.className : "";
  return `${node.tagName.toLowerCase()}.${cls.trim().split(/\s+/).slice(0, 2).join(".")}${kind ? `[${kind}]` : ""}`;
}

export function routerTrace(
  event: string,
  detail: Record<string, unknown> = {},
): void {
  if (!ROUTER_TRACE) return;
  const target = window as unknown as { __SHARECUT_E2E_ROUTER?: unknown[] };
  target.__SHARECUT_E2E_ROUTER ??= [];
  target.__SHARECUT_E2E_ROUTER.push({
    t: Math.round(performance.now() * 10) / 10,
    event,
    ...detail,
  });
}
