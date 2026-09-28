/**
 * The sanity cadence for host meta polls (`useFileMetaPoll`: project and
 * session meta) and the host offline-queue drain timer (`useDocumentSync`).
 * Sockets deliver in-process changes immediately; this only catches writes
 * made by other processes (#662). Plain module, so non-hook code such as
 * `commands/trackMix.ts` can size its windows from it.
 */
export const SANITY_POLL_MS = 30_000;
