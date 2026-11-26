/** Longest message still read well after "Undone: ". */
const SHORT_MESSAGE = 48;

/** "Undone: <message>" for a short single clause; a longer or multi-part message would read oddly, so it is a bare "Undone." */
export function undoneText(message: string): string {
  const single =
    message.length <= SHORT_MESSAGE && !/\.\s|:|·/.test(message.trim());
  return single ? `Undone: ${message}` : "Undone.";
}
