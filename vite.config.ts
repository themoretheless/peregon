import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const PLACEHOLDER_DATABASE_ID = "00000000-0000-4000-8000-000000000000";
const { d1, r2 } = hostingConfig;
const isCodexSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const workerConfig = {
  name: "server",
  main: "./worker/index.ts",
  compatibility_date: "2026-05-22",
  compatibility_flags: ["nodejs_compat"],
  assets: {
    binding: "ASSETS",
    not_found_handling: "single-page-application" as const,
    run_worker_first: true,
  },
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "json-rivet-d1",
          database_id: PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "json-rivet-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vue(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "server" },
        config: workerConfig,
      }),
    ],
  };
});
