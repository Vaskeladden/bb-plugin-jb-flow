import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "jsdom",
    // A UI test renders the whole plugin app in jsdom; a file's first render alone
    // can take 5 seconds, so vitest's default limit failed healthy tests.
    testTimeout: 20_000,
    include: [
      "workspaces.test.ts",
      "workspaces.ui.test.tsx",
      "studio.ui.test.tsx",
      "shell-appearance.ui.test.tsx",
      "live-activity.ui.test.tsx",
      "timeline-activity.ui.test.tsx",
      "thread-status.test.ts",
      "section-order.test.ts",
      "decision-choices.ui.test.tsx",
      "palette.ui.test.tsx",
      "catch-up.ui.test.tsx",
      "row-status.ui.test.tsx",
      "thread-tree.ui.test.tsx",
    ],
  },
});
