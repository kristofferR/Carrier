/*
 * Bundles the typed inject sources (inject/src/) into the single plain-JS
 * files the Rust shell embeds with include_str! (src-tauri/inject/). Run with
 * `bun run build:inject`; CI rebuilds and fails if the committed output is
 * stale (`git diff --exit-code src-tauri/inject`).
 */
import { build } from "esbuild";

const banner = (source: string) =>
  [
    "/*",
    " * GENERATED FILE — DO NOT EDIT.",
    ` * Source: ${source} (bundled by inject/build.ts via \`bun run build:inject\`).`,
    " */",
  ].join("\n");

const common = {
  bundle: true,
  format: "iife",
  // Keep modern syntax (optional chaining etc.) as-is; the WebViews Tauri v2
  // targets all support ES2020. No minification: the output is committed and
  // reviewed, and readable stack traces from the field matter more than bytes.
  target: "es2020",
  charset: "utf8",
  legalComments: "none",
  outdir: "src-tauri/inject",
} as const;

for (const [entry, out, source] of [
  ["inject/src/messenger/index.ts", "messenger", "inject/src/messenger/"],
  ["inject/src/panel/index.ts", "panel", "inject/src/panel/index.ts"],
] as const) {
  await build({
    ...common,
    entryPoints: { [out]: entry },
    banner: { js: banner(source) },
  });
}
