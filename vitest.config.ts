import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "jsdom",
    include: [
      "workspaces.test.ts",
      "workspaces.ui.test.tsx",
      "studio.ui.test.tsx",
      "shell-appearance.ui.test.tsx",
      "live-activity.ui.test.tsx",
      "timeline-activity.ui.test.tsx",
      "thread-status.test.ts",
      "decision-choices.ui.test.tsx",
      "palette.ui.test.tsx",
      "catch-up.ui.test.tsx",
      "row-status.ui.test.tsx",
    ],
  },
});
