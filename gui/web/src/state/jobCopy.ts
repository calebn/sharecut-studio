export function joinJobCopy(
  parts: readonly (string | null | undefined | false)[],
): string {
  return parts
    .filter((part): part is string => Boolean(part))
    .reduce((joined, part) => {
      if (!joined) return part;
      return `${joined}${/[.!?…]$/.test(joined) ? " " : ". "}${part}`;
    }, "");
}
