// Put the curated GitHub release notes in the Linux AppStream metadata, which
// software centers show: every vX.Y.Z release newer than the file's newest
// <release>, this tag's draft included. The release workflow runs it before
// bundling and doesn't commit the result.
// Usage: bun scripts/release/metainfo.ts <version>

const METAINFO = "src-tauri/linux/app.chatpane.Chatpane.metainfo.xml";
/** Sections written for people using the app; Internal and the like are left out. */
const USER_SECTIONS = new Set(["What's New", "Bug Fixes"]);

export interface Release {
  version: string;
  date: string;
  notes: string;
}

const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** Markdown inline text as plain text: link text, no emphasis, code or PR numbers. */
const plain = (text: string) =>
  escapeXml(
    text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<(https?:\/\/[^>]+)>/g, "$1")
      .replace(/\s*\((?:#\d+(?:,\s*)?)+\)/g, "")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/`([^`]*)`/g, "$1")
      .trim(),
  );

/**
 * The parts of curated release notes a software center shows, as AppStream
 * description markup: the opening paragraphs, then each What's New and Bug
 * Fixes list under its heading.
 */
export function appstreamDescription(markdown: string): string {
  const out: string[] = [];
  let section: string | null = null;
  let paragraph: string[] = [];
  let items: string[] = [];
  const shown = () => section === null || USER_SECTIONS.has(section);
  const endParagraph = () => {
    if (paragraph.length && shown()) out.push(`<p>${plain(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const endList = () => {
    if (items.length && shown())
      out.push(`<ul>${items.map((i) => `<li>${plain(i)}</li>`).join("")}</ul>`);
    items = [];
  };
  for (const raw of markdown.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    if (heading) {
      endParagraph();
      endList();
      section = (heading[1] ?? "").trim();
      if (shown()) out.push(`<p>${plain(section)}</p>`);
    } else if (bullet) {
      endParagraph();
      items.push(bullet[1] ?? "");
    } else if (!line) {
      endParagraph();
    } else if (items.length && raw !== line) {
      // An indented line continues the list item above it.
      items[items.length - 1] += ` ${line}`;
    } else {
      endList();
      paragraph.push(line);
    }
  }
  endParagraph();
  endList();
  return out.join("\n");
}

const versionParts = (version: string) => version.split(".").map(Number);

export function compareVersions(a: string, b: string): number {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

function releaseXml({ version, date, notes }: Release): string {
  const description = appstreamDescription(notes);
  // An internal-only release still gets its entry, with nothing to describe.
  if (!description) return `    <release version="${version}" date="${date}"/>\n`;
  const body = description
    .split("\n")
    .map((line) => `        ${line}`)
    .join("\n");
  return `    <release version="${version}" date="${date}">\n      <description>\n${body}\n      </description>\n    </release>\n`;
}

/** `metainfo` with an entry for each release newer than its newest one, newest first. */
export function withReleases(metainfo: string, releases: Release[]): string {
  const newest = /<release version="([^"]+)"/.exec(metainfo)?.[1];
  const added = releases
    .filter((release) => !newest || compareVersions(release.version, newest) > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  if (!metainfo.includes("<releases>\n")) throw new Error("The metainfo has no <releases> list.");
  return metainfo.replace("<releases>\n", () => `<releases>\n${added.map(releaseXml).join("")}`);
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  body: string | null;
}

/** This version's release (its draft while the workflow builds it) and every published one before it. */
async function githubReleases(version: string): Promise<Release[]> {
  const repo = process.env.GITHUB_REPOSITORY ?? "kristofferR/Chatpane";
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const today = new Date().toISOString().slice(0, 10);
  const releases: Release[] = [];
  for (let page = 1; ; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
    );
    if (!response.ok) throw new Error(`Listing GitHub releases failed: HTTP ${response.status}`);
    const batch = (await response.json()) as GitHubRelease[];
    for (const release of batch) {
      const tagged = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name)?.[1];
      if (!tagged || release.prerelease) continue;
      const published = (release.published_at ?? "").slice(0, 10);
      const notes = release.body ?? "";
      if (tagged === version) {
        releases.push({ version: tagged, date: release.draft ? today : published, notes });
      } else if (!release.draft && compareVersions(tagged, version) < 0) {
        releases.push({ version: tagged, date: published, notes });
      }
    }
    if (batch.length < 100) break;
  }
  if (!releases.some((release) => release.version === version)) {
    throw new Error(`No GitHub release exists for v${version}.`);
  }
  return releases;
}

if (import.meta.main) {
  const version = process.argv[2] ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Usage: bun scripts/release/metainfo.ts <X.Y.Z>");
  const before = await Bun.file(METAINFO).text();
  const after = withReleases(before, await githubReleases(version));
  await Bun.write(METAINFO, after);
  const added = [...after.matchAll(/<release version="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((v) => !before.includes(`<release version="${v}"`));
  console.log(
    added.length
      ? `Added release notes for ${added.join(", ")}.`
      : "The metainfo already lists every release.",
  );
}
