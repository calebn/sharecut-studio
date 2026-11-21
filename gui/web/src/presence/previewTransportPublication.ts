export type PreviewTransportRequest = Readonly<{
  projectEpoch: number;
  immediate: boolean;
  seek: boolean;
}>;

type WriteTransport = (request: PreviewTransportRequest) => void;

let pending: Map<WriteTransport, PreviewTransportRequest> | null = null;

export function withSettledPreviewTransport<T>(resume: () => T): T {
  if (pending) return resume();
  const requests = new Map<WriteTransport, PreviewTransportRequest>();
  pending = requests;
  try {
    return resume();
  } finally {
    pending = null;
    for (const [write, request] of requests) write(request);
  }
}

export function stagePreviewTransport(
  write: WriteTransport,
  request: PreviewTransportRequest,
): boolean {
  if (!pending) return false;
  const previous = pending.get(write);
  pending.set(
    write,
    previous?.projectEpoch === request.projectEpoch
      ? {
          projectEpoch: request.projectEpoch,
          immediate: request.immediate || previous.immediate,
          seek: request.seek || previous.seek,
        }
      : request,
  );
  return true;
}
