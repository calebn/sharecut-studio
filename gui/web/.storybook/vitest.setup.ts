import { setProjectAnnotations } from "@storybook/react-vite";
import { reportCleanupRejections } from "../src/test/storyCleanupErrors";
import * as preview from "./preview";

setProjectAnnotations([
  {
    ...preview.default,
    beforeEach: reportCleanupRejections(preview.default.beforeEach),
  },
]);
