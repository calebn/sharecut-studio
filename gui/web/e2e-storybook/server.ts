const rawPort = process.env.STORYBOOK_E2E_PORT?.trim();
export const storybookPort = rawPort ? Number(rawPort) : 6010;

if (
  !Number.isInteger(storybookPort) ||
  storybookPort < 1 ||
  storybookPort > 65535
) {
  throw new Error("STORYBOOK_E2E_PORT must be an integer from 1 to 65535");
}

export const storybookUrl = `http://127.0.0.1:${storybookPort}`;
