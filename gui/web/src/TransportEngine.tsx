import { useAudioTransport } from "./hooks/useAudioTransport";
import { useFollowTransport } from "./hooks/useFollowTransport";
import { useFollowUi } from "./hooks/useFollowUi";
import { useFollowViewport } from "./hooks/useFollowViewport";
import { useProxyTransport } from "./hooks/useProxyTransport";

/**
 * Playback and follow engines as a leaf that renders nothing. They select
 * the playhead and the session roster, so their per-frame renders stay here
 * instead of re-rendering the whole app. The proxy and audio transports stay
 * in one component: which one drives playback is decided in the same render.
 */
export function TransportEngine() {
  useFollowTransport();
  const proxyActive = useProxyTransport();
  useAudioTransport(!proxyActive);
  return null;
}

/** Applies a followed client's viewport and UI; renders nothing. */
export function FollowEngine() {
  useFollowViewport();
  useFollowUi();
  return null;
}
