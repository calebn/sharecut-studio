import { vi } from "vitest";

/**
 * A fake host `page` whose `page.request.post` resolves to a response with
 * the given `ok`, `status` (default 200 when ok, else 400) and JSON `body`.
 * Shared by the e2e helper unit tests (`recordRoom.test.ts`,
 * `shareNavigation.test.ts`).
 */
export function hostWithResponse(
  ok: boolean,
  body: unknown,
  status = ok ? 200 : 400,
) {
  const post = vi.fn(async () => ({
    ok: () => ok,
    status: () => status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }));
  return { page: { request: { post } }, post };
}
