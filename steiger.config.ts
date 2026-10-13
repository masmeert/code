import fsd from "@feature-sliced/steiger-plugin";
import { defineConfig } from "steiger";

export default defineConfig([
  ...fsd.configs.recommended,
  {
    // "settings" is uncountable here, and the rule reads it as a plural among singular entities.
    rules: { "fsd/inconsistent-naming": "off" },
  },
]);
