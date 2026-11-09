/**
 * Localized guide pages. Each scripts/site/guides/<lang>/<page>.html holds a
 * page's own content (hero, article, FAQ) after a short header comment:
 *
 *   <!--
 *   slug: descargar-messenger-para-pc   (URL: /<lang>/<slug>/)
 *   group: windows                      (a key of GROUPS)
 *   title: …                            (<title>, og:title, twitter:title)
 *   description: …                      (meta, og and twitter descriptions)
 *   label: …                            (link text on sibling pages)
 *   -->
 *
 * This wraps it in the shared guide layout (header, download block, footer)
 * using the landing page translation for the shared strings, and writes
 * docs/<lang>/<slug>/index.html. Pages in one group are translations of the
 * same English page, so each gets hreflang alternates for its siblings, and the
 * English page's own `guide-alternates` block is regenerated to match. A FAQ in
 * the content also becomes FAQPage structured data.
 */
import { readdir, rm, rmdir } from "node:fs/promises";

/** English page each group localizes, relative to the site root. */
export const GROUPS: Record<string, string> = {
  windows: "messenger-for-windows/",
  shutdown: "messenger-desktop-app-discontinued/",
};

/** Open Graph locale per language (Facebook's own codes). */
const OG_LOCALES: Record<string, string> = {
  es: "es_LA",
  fil: "tl_PH",
  id: "id_ID",
  pl: "pl_PL",
  "pt-BR": "pt_BR",
  vi: "vi_VN",
};

export type Guide = {
  lang: string;
  slug: string;
  group: string;
  title: string;
  description: string;
  label: string;
  body: string;
};

export type GuideContext = {
  docs: URL;
  site: string;
  download: string;
  version: string;
  generated: string;
  /** The landing page template, for the language menu's names. */
  template: string;
  /** Flat landing-page strings per language, with download tokens resolved. */
  strings: (lang: string) => Record<string, string>;
  write: (path: string, contents: string) => Promise<void>;
};

export async function loadGuides(): Promise<Guide[]> {
  const sources = new URL("guides/", import.meta.url);
  const guides: Guide[] = [];
  for (const lang of (await readdir(sources)).sort()) {
    for (const name of (await readdir(new URL(`${lang}/`, sources))).sort()) {
      if (!name.endsWith(".html")) continue;
      const raw = await Bun.file(new URL(`${lang}/${name}`, sources)).text();
      guides.push(parse(lang, `${lang}/${name}`, raw));
    }
  }
  return guides;
}

export async function buildGuides(ctx: GuideContext, guides: Guide[]) {
  const names = languageNames(ctx.template);
  const written = new Set<string>();
  for (const guide of guides) {
    const path = `${guide.lang}/${guide.slug}/index.html`;
    if (written.has(path)) throw new Error(`Two guides write docs/${path}`);
    written.add(path);
    await ctx.write(path, render(ctx, guide, guides, names));
  }

  // The English pages link back to every translation.
  for (const [group, english] of Object.entries(GROUPS)) {
    const path = `${english}index.html`;
    const html = await Bun.file(new URL(path, ctx.docs)).text();
    const block = /(<!-- guide-alternates -->\n)[\s\S]*?(<!-- \/guide-alternates -->)/;
    if (!block.test(html)) throw new Error(`docs/${path} has no guide-alternates block`);
    const links = alternates(ctx, group, guides).join("\n");
    await ctx.write(
      path,
      html.replace(block, (_, open: string, close: string) => `${open}${links}\n${close}`),
    );
  }

  // Remove generated guides whose source is gone.
  for await (const path of new Bun.Glob("*/*/index.html").scan(ctx.docs.pathname)) {
    if (written.has(path)) continue;
    const target = new URL(path, ctx.docs);
    if (!(await Bun.file(target).text()).includes(ctx.generated)) continue;
    await rm(target);
    await rmdir(new URL(path.slice(0, -"index.html".length), ctx.docs)).catch(() => {});
    console.log(`removed docs/${path}`);
  }
}

function parse(lang: string, source: string, raw: string): Guide {
  const header = raw.match(/^<!--\n([\s\S]*?)\n-->\n/);
  if (!header?.[1]) throw new Error(`${source} has no header comment`);
  const fields = new Map<string, string>();
  for (const line of header[1].split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match?.[1] && match[2]) fields.set(match[1], match[2].trim());
  }
  const field = (key: string) => {
    const value = fields.get(key);
    if (!value) throw new Error(`${source} is missing "${key}"`);
    return value;
  };
  const guide = {
    lang,
    slug: field("slug"),
    group: field("group"),
    title: field("title"),
    description: field("description"),
    label: field("label"),
    body: raw.slice(header[0].length),
  };
  if (!/^[a-z0-9-]+$/.test(guide.slug)) throw new Error(`${source} has an invalid slug`);
  // These go into attributes unescaped.
  for (const value of [guide.title, guide.description, guide.label]) {
    if (/[<>"&]/.test(value)) throw new Error(`${source}: no < > " & in the header fields`);
  }
  if (!GROUPS[guide.group]) throw new Error(`${source} names an unknown group`);
  if (!OG_LOCALES[lang]) throw new Error(`${source}: add ${lang} to OG_LOCALES`);
  return guide;
}

function alternates(ctx: GuideContext, group: string, guides: Guide[]): string[] {
  const english = `${ctx.site}${GROUPS[group]}`;
  return [
    `<link rel="alternate" hreflang="en" href="${english}">`,
    ...guides
      .filter((guide) => guide.group === group)
      .map((g) => `<link rel="alternate" hreflang="${g.lang}" href="${pageUrl(ctx, g)}">`),
    `<link rel="alternate" hreflang="x-default" href="${english}">`,
  ];
}

const pageUrl = (ctx: GuideContext, guide: Guide) => `${ctx.site}${guide.lang}/${guide.slug}/`;

/** "🇻🇳 Tiếng Việt" per language code, from the landing page's language menu. */
function languageNames(template: string): Record<string, string> {
  const names: Record<string, string> = {};
  for (const [, code, name] of template.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)) {
    if (code && name) names[code] = name;
  }
  return names;
}

function render(
  ctx: GuideContext,
  guide: Guide,
  guides: Guide[],
  names: Record<string, string>,
): string {
  const t = ctx.strings(guide.lang);
  const s = (key: string) => {
    const value = t[key];
    if (value === undefined) throw new Error(`${guide.lang}.json is missing ${key}`);
    return value;
  };
  const url = pageUrl(ctx, guide);
  const body = guide.body
    .replaceAll("{download}", ctx.download)
    .replaceAll("{version}", ctx.version);
  const siblings = guides.filter((g) => g.lang === guide.lang && g !== guide);
  const translations = guides.filter((g) => g.group === guide.group && g !== guide);
  const english = `../../${GROUPS[guide.group]}`;
  const faq = faqData(body);

  return `<!DOCTYPE html>
${ctx.generated} from scripts/site/guides/${guide.lang}. Do not edit. -->
<html lang="${guide.lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${guide.title}</title>
<meta name="description" content="${guide.description}">
<link rel="canonical" href="${url}">
${alternates(ctx, guide.group, guides).join("\n")}
<meta property="og:type" content="article">
<meta property="og:site_name" content="Chatpane for Messenger">
<meta property="og:locale" content="${OG_LOCALES[guide.lang]}">
<meta property="og:title" content="${guide.title}">
<meta property="og:description" content="${guide.description}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${ctx.site}social-preview.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${s("meta.imageAlt")}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${guide.title}">
<meta name="twitter:description" content="${guide.description}">
<meta name="twitter:image" content="${ctx.site}social-preview.png">
<link rel="icon" href="../../app-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@600;700;800&family=Nunito+Sans:opsz,wght@6..12,400;6..12,600;6..12,700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../../assets/guide.css">
${faq ? `<script type="application/ld+json">\n${faq}\n</script>\n` : ""}</head>
<body>
<a class="skip-link" href="#main">${s("nav.skip")}</a>

<header class="site-head">
  <div class="wrap">
    <a class="brand" href="../">
      <img src="../../app-icon.png" alt="" width="34" height="34">
      Chatpane
    </a>
    <nav class="site-nav" aria-label="${s("a11y.navMain")}">
      <a class="nav-hide-sm" href="../#features">${s("nav.features")}</a>
      <a class="nav-hide-sm" href="https://github.com/kristofferR/Chatpane" target="_blank" rel="noopener">GitHub</a>
      <a class="nav-cta" href="#download">${s("nav.download")}</a>
    </nav>
  </div>
</header>

<main id="main">
${body.trim()}

  <div class="download-wrap">
    <section class="download" id="download" aria-labelledby="dl-title">
      <span class="orb d1" aria-hidden="true"></span>
      <span class="orb d2" aria-hidden="true"></span>
      <h2 id="dl-title">${s("dl.title")}</h2>
      <p class="dl-sub">${s("dl.sub")}</p>
      <div class="dl-grid">
        <div class="dl-col">
          <a class="dl" href="${ctx.download}win_x64_setup.exe">
            <span class="dl-ico" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="#0084FF"><path d="M0 3.449 9.75 2.1v9.451H0zM10.949 1.949 24 0v11.4H10.949zM0 12.6h9.75v9.451L0 20.699zM10.949 12.6H24V24l-13.051-1.801z"/></svg></span>
            <span><b>${s("dl.win.title")}</b><small>${s("dl.win.sub")}</small></span>
          </a>
          <p class="dl-alts">${s("dl.win.alts")}</p>
        </div>
        <div class="dl-col">
          <a class="dl" href="${ctx.download}mac_arm.dmg">
            <span class="dl-ico" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="#1d2129"><path d="${APPLE}"/></svg></span>
            <span><b>${s("dl.mac.title")}</b><small>${s("dl.mac.sub")}</small></span>
          </a>
          <p class="dl-alts">${s("dl.mac.alts")}</p>
        </div>
        <div class="dl-col">
          <a class="dl" href="${ctx.download}lin_x64.AppImage">
            <span class="dl-ico" aria-hidden="true">${TUX}</span>
            <span><b>${s("dl.lin.title")}</b><small>${s("dl.lin.sub")}</small></span>
          </a>
          <p class="dl-alts">${s("dl.lin.alts")}</p>
        </div>
      </div>
      <p class="other-versions">${s("dl.other")}</p>
    </section>
  </div>
${
  siblings.length
    ? `
  <section aria-labelledby="more-title">
    <div class="wrap narrow">
      <h2 id="more-title" class="sec-title">${s("a11y.navGuides")}</h2>
      <div class="guide-links">
${siblings.map((g) => `        <a href="../${g.slug}/">${g.label}</a>`).join("\n")}
        <a href="../">Chatpane</a>
      </div>
    </div>
  </section>
`
    : ""
}</main>

<footer class="site-foot">
  <div class="wrap">
    <div class="foot-top">
      <a class="foot-brand" href="../"><img src="../../app-icon.png" alt="" width="30" height="30">Chatpane for Messenger</a>
      <nav class="foot-links" aria-label="${s("a11y.navFooter")}">
        <a href="https://github.com/kristofferR/Chatpane" target="_blank" rel="noopener">GitHub</a>
        <a href="https://github.com/kristofferR/Chatpane/releases/latest" target="_blank" rel="noopener">${s("foot.releases")}</a>
      </nav>
    </div>
    <nav class="foot-guides" aria-label="${s("a11y.lang")}">
      <a href="${english}" hreflang="en" lang="en">${names.en ?? "English"}</a>
${translations
  .map(
    (g) =>
      `      <a href="../../${g.lang}/${g.slug}/" hreflang="${g.lang}" lang="${g.lang}">${names[g.lang] ?? g.lang}</a>`,
  )
  .join("\n")}
    </nav>
    <p class="foot-note">${s("foot.license")}</p>
    <p class="foot-note">${s("foot.disclaimer")}</p>
    <p class="foot-heart">${s("foot.credit")}</p>
  </div>
</footer>
</body>
</html>
`;
}

/** FAQPage structured data from the content's FAQ, word for word. */
function faqData(body: string): string | null {
  const items = [
    ...body.matchAll(
      /<summary><h3>([\s\S]*?)<\/h3>[\s\S]*?<\/summary>\s*<p class="faq-a">([\s\S]*?)<\/p>/g,
    ),
  ];
  if (!items.length) return null;
  const plain = (html: string) =>
    html
      .replace(/<[^>]+>/g, "")
      .replaceAll("&nbsp;", " ")
      .replaceAll("&quot;", '"')
      .replaceAll("&amp;", "&")
      .replace(/\s+/g, " ")
      .trim();
  const data = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map(([, question = "", answer = ""]) => ({
      "@type": "Question",
      name: plain(question),
      acceptedAnswer: { "@type": "Answer", text: plain(answer) },
    })),
  };
  return JSON.stringify(data, null, 2).replaceAll("</", "<\\/");
}

const APPLE =
  "M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.287-1.82-2.323-4.63-2.323-7.28 0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.613 0 2.886.06 4.374 2.19-.13.09-2.383 1.37-2.383 4.19 0 3.26 2.854 4.42 2.955 4.45z";

const TUX =
  '<svg width="24" height="24" viewBox="0 0 24 24"><ellipse cx="12" cy="15" rx="6.6" ry="7.2" fill="#1d2129"/><circle cx="12" cy="7" r="4.4" fill="#1d2129"/><ellipse cx="12" cy="16.6" rx="3.7" ry="4.6" fill="#fff"/><circle cx="10.4" cy="6.3" r=".75" fill="#fff"/><circle cx="13.6" cy="6.3" r=".75" fill="#fff"/><path d="M12 7.2 10.6 8.9h2.8z" fill="#f6a623"/><ellipse cx="9.2" cy="21.4" rx="1.9" ry="1.1" fill="#f6a623"/><ellipse cx="14.8" cy="21.4" rx="1.9" ry="1.1" fill="#f6a623"/></svg>';
