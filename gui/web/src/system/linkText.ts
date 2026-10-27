export function middleTruncate(link: string, keep = 14): string {
  return link.length <= keep * 2 + 1
    ? link
    : `${link.slice(0, keep)}…${link.slice(-keep)}`;
}
