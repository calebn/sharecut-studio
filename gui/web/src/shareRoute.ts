export type ShareRoute = { kind: "review" | "record"; token: string };

export function parseShareRoute(pathname: string): ShareRoute | null {
  const rec = pathname.match(/^\/rec\/([^/]+)\/?$/);
  if (rec) {
    return { kind: "record", token: decodeURIComponent(rec[1]) };
  }
  const review = pathname.match(/^\/r\/([^/]+)\/?$/);
  if (review) {
    return { kind: "review", token: decodeURIComponent(review[1]) };
  }
  return null;
}

export function recordApiBase(token: string): string {
  return `/api/rec/${encodeURIComponent(token)}`;
}

export function reviewApiBase(token: string): string {
  return `/api/review/${encodeURIComponent(token)}`;
}
