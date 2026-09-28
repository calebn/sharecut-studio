/**
 * The sanity cadence for host meta polls (`useFileMetaPoll`: project and
 * session meta) and the host offline-queue drain timer (`useDocumentSync`).
 * Sockets deliver in-process changes immediately; other processes' journal
 * writes also arrive over the sockets via the server's cross-process watcher
 * (#695) — this is only a sanity net. Plain module, so non-hook code such as
 * `commands/trackMix.ts` can size its windows from it.
 */
export const SANITY_POLL_MS = 30_000;
