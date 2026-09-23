import { useRecordHostStore } from "./hostStore";
import {
  type ByteSink,
  createOpfsSink,
  OpfsUnavailableError,
} from "./keeper/store";
import { OPFS_UNAVAILABLE_COPY, UPLOAD_SINK_ERROR_COPY } from "./types";

let pending: Promise<ByteSink> | null = null;

/** The host transport and keeper capture must use the same verified OPFS root. */
export function prepareHostKeeperStorage(): Promise<ByteSink> {
  const state = useRecordHostStore.getState();
  if (state.keeperSink) {
    return Promise.resolve(state.keeperSink);
  }
  if (pending) {
    return pending;
  }
  state.setKeeperStorage(null, null);
  const attempt = createOpfsSink()
    .then((sink) => {
      useRecordHostStore.getState().setKeeperStorage(sink, null);
      return sink;
    })
    .catch((error: unknown) => {
      useRecordHostStore
        .getState()
        .setKeeperStorage(
          null,
          error instanceof OpfsUnavailableError
            ? OPFS_UNAVAILABLE_COPY
            : UPLOAD_SINK_ERROR_COPY,
        );
      throw error;
    })
    .finally(() => {
      if (pending === attempt) {
        pending = null;
      }
    });
  pending = attempt;
  return attempt;
}

export function retryHostKeeperStorage(): Promise<ByteSink> {
  useRecordHostStore.getState().setKeeperStorage(null, null);
  return prepareHostKeeperStorage();
}
