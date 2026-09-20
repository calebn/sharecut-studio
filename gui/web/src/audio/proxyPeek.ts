import type { ProxyEngine } from "./proxyEngine";

let active: ProxyEngine | null = null;

export function setActiveProxyEngine(engine: ProxyEngine | null): void {
  active = engine;
}

export function getActiveProxyEngine(): ProxyEngine | null {
  return active;
}
