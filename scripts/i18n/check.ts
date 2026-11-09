// Check translations against en.json: missing or extra keys, plural forms,
// placeholders. Run: bun scripts/i18n/check.ts [code…] (default: every
// locale). `cargo test --lib i18n` enforces the same rules in CI.
import { readdir } from "node:fs/promises";

const en = (await Bun.file("src-tauri/locales/en.json").json()) as Record<string, string>;
const base = (key: string) => key.split("#")[0] as string;
const plain = (map: Record<string, string>) => Object.keys(map).filter((k) => !k.includes("#"));
const plurals = (map: Record<string, string>) =>
  new Set(
    Object.keys(map)
      .filter((k) => k.includes("#"))
      .map(base),
  );
const names = (text: string) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
const categories = new Set(["zero", "one", "two", "few", "many", "other"]);
let failed = false;
const codes = process.argv.slice(2);
if (codes.length === 0) {
  for (const file of await readdir("src-tauri/locales")) {
    if (file.endsWith(".json") && file !== "en.json") codes.push(file.slice(0, -5));
  }
}
for (const code of codes) {
  let t: Record<string, string>;
  try {
    t = await Bun.file(`src-tauri/locales/${code}.json`).json();
  } catch (error) {
    failed = true;
    console.log(`${code}: invalid JSON (${error})`);
    continue;
  }
  const problems: string[] = [];
  const enPlain = new Set(plain(en));
  const tPlain = new Set(plain(t));
  for (const k of enPlain) if (!tPlain.has(k)) problems.push(`missing ${k}`);
  for (const k of tPlain) if (!enPlain.has(k)) problems.push(`extra ${k}`);
  const enPl = plurals(en);
  const tPl = plurals(t);
  for (const k of enPl)
    if (!tPl.has(k) || !(`${k}#other` in t)) problems.push(`plural ${k} lacks #other`);
  for (const k of tPl) if (!enPl.has(k)) problems.push(`extra plural ${k}`);
  for (const [k, v] of Object.entries(t)) {
    if (typeof v !== "string" || !v.trim()) problems.push(`empty ${k}`);
    if (v.includes("&&")) problems.push(`&& in ${k}`);
    if (k.includes("#")) {
      const category = k.slice(k.indexOf("#") + 1);
      if (!categories.has(category)) problems.push(`bad plural category ${k}`);
      const allowed = names(en[`${base(k)}#other`] ?? "");
      for (const n of names(v))
        if (!allowed.has(n)) problems.push(`placeholder {${n}} not in en: ${k}`);
    } else if (en[k] !== undefined) {
      const a = [...names(en[k])].sort().join(",");
      const b = [...names(v)].sort().join(",");
      if (a !== b) problems.push(`placeholders differ in ${k}: en {${a}} vs {${b}}`);
    }
  }
  failed ||= problems.length > 0;
  console.log(`${code}: ${Object.keys(t).length} keys, ${problems.length} problems`);
  for (const p of problems.slice(0, 40)) console.log(`  ${p}`);
}
process.exit(failed ? 1 : 0);
