import type { Preview } from "@storybook/react-vite";

type BeforeEach = Exclude<Preview["beforeEach"], undefined | unknown[]>;
let activeCleanupErrors: unknown[] | undefined;

export function observeCleanupErrors(errors: unknown[]) {
  activeCleanupErrors = errors;
  return () => {
    activeCleanupErrors = undefined;
  };
}

function withReportedCleanup(setup: BeforeEach): BeforeEach {
  return async (context) => {
    const errors = activeCleanupErrors;
    const cleanup = await setup(context);
    if (!cleanup || !errors) return cleanup;
    return async () => {
      try {
        await cleanup();
      } catch (error) {
        // Storybook clears its cleanup queue only after every callback fulfills.
        errors.push(error);
      }
    };
  };
}

export function reportCleanupRejections(
  hooks: Preview["beforeEach"],
): Preview["beforeEach"] {
  if (Array.isArray(hooks)) return hooks.map(withReportedCleanup);
  return hooks && withReportedCleanup(hooks);
}
