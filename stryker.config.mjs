// Spike: mutation testing scoped to pickup.js only. Run with `npx stryker run`.
export default {
  // The vitest runner runs tests in Node, where `cloudflare:test` doesn't exist.
  // The command runner shells out to vitest so tests stay in the Workers pool.
  // shortcut: every mutant runs the whole suite (no per-test coverage), so it's slow; fine for one file.
  testRunner: "command",
  commandRunner: { command: "npx vitest run" },
  mutate: ["src/pickup.js"],
  // docs/company is a symlink outside the repo that Stryker can't copy into its sandbox
  ignorePatterns: ["docs"],
  // Delete sandboxes even when a run fails (default only cleans on success), so stale copies
  // never pile up. To keep one for debugging: `npx stryker run --cleanTempDir false`.
  cleanTempDir: "always",
  reporters: ["clear-text", "html", "progress"],
};
