import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		// istanbul (not v8): coverage must be instrumented to work inside the Workers pool
		coverage: { provider: "istanbul", include: ["src/**"] },
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
			},
		},
	},
});
