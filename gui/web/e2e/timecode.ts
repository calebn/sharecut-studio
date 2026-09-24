/** Seconds from a timecode or ruler label: `ss`, `mm:ss.mmm` or `hh:mm:ss`. */
export function parseTimecodeSec(text: string): number {
  return text
    .trim()
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0);
}
