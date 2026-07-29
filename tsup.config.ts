import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "es2022",
    dts: true,
    sourcemap: true,
    clean: true,
  },
  {
    entry: {
      cli: "src/cli.ts",
    },
    format: ["esm"],
    target: "es2022",
    banner: {
      js: "#!/usr/bin/env node",
    },
    sourcemap: true,
  },
]);
