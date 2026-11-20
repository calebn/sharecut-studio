import type { Page } from "@playwright/test";

type ChannelWindow = {
  __STORYBOOK_ADDONS_CHANNEL__: {
    emit: (event: string, payload: unknown) => void;
  };
};

/** Sends an event to the open story's preview, as the Storybook UI does. */
export const emit = (page: Page, event: string, payload: unknown) =>
  page.evaluate(
    ({ event, payload }) =>
      (window as unknown as ChannelWindow).__STORYBOOK_ADDONS_CHANNEL__.emit(
        event,
        payload,
      ),
    { event, payload },
  );
