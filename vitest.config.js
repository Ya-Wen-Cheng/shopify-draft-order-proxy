import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		// Stryker sandboxes contain copies of the specs; don't run them as part of the real suite
		exclude: ["**/node_modules/**", ".stryker-tmp/**"],
		// istanbul (not v8): coverage must be instrumented to work inside the Workers pool
		coverage: { provider: "istanbul", include: ["src/**"] },
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				// One bindings object on purpose: a second `miniflare` key would replace this one
				// during Stryker runs and drop the fake secrets.
				miniflare: {
					bindings: {
						// Override .dev.vars secrets so tests (incl. the Durable Object, which reads its own env)
						// can never call the real store with a real token if a fetch mock is missing.
						SHOPIFY_TOKEN: "test-token",
						SHOPIFY_WEBHOOK_SECRET: "test-webhook-secret",
						// Stryker picks the active mutant from process.env, which workerd can't see from the host.
						// Forward it as a binding (nodejs_compat exposes bindings on process.env). No-op outside Stryker.
						...(process.env.__STRYKER_ACTIVE_MUTANT__ && {
							__STRYKER_ACTIVE_MUTANT__: process.env.__STRYKER_ACTIVE_MUTANT__,
						}),
					},
				},
			},
		},
	},
});
