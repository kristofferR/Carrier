#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }).trim();
  } catch {
    return "";
  }
}

function parseSemver(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function previousReleaseTag(currentTag) {
  const current = parseSemver(currentTag);
  if (!current) return "";

  const tags = run("git", ["tag", "--list", "v*"])
    .split(/\r?\n/)
    .map((name) => ({ name, version: parseSemver(name) }))
    .filter((entry) => entry.version && compareSemver(entry.version, current) < 0)
    .sort((a, b) => compareSemver(b.version, a.version));

  return tags[0]?.name || "";
}

function parseCommits(range) {
  const raw = run("git", [
    "log",
    "--first-parent",
    "--reverse",
    "--format=%H%x1f%s%x1f%b%x1e",
    range,
  ]);
  if (!raw) return [];

  return raw
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, subject, ...bodyParts] = record.split("\x1f");
      return {
        sha,
        subject: subject.trim(),
        body: bodyParts.join("\x1f").trim(),
      };
    });
}

function issueRefs(text) {
  const refs = new Set();
  for (const match of text.matchAll(/\b(?:Ref|See)\s+#(\d+)\b/gi)) {
    refs.add(match[1]);
  }
  return [...refs];
}

function prNumberFromSubject(subject) {
  return (
    /^Merge pull request #(\d+)/.exec(subject)?.[1] ||
    /^Merge PR #(\d+)/.exec(subject)?.[1] ||
    /\(#(\d+)\)$/.exec(subject)?.[1] ||
    ""
  );
}

function isNoiseSubject(subject) {
  return (
    /^Bump version to\b/i.test(subject) ||
    /^Merge origin\/main\b/i.test(subject)
  );
}

function stripGeneratedBlocks(body) {
  return body.replace(/<!-- This is an auto-generated comment:[\s\S]*?<!-- end of auto-generated comment:[\s\S]*?-->/g, "");
}

function summaryBullets(body) {
  const clean = stripGeneratedBlocks(body);
  const summary = /## Summary\s+([\s\S]*?)(?:\n##\s+|$)/i.exec(clean)?.[1] || "";
  return summary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/\.$/, ""))
    .slice(0, 2);
}

function mergedPullRequests(previousTag, currentTag) {
  const repo = process.env.GITHUB_REPOSITORY || "kristofferR/Carrier";
  const previousDate = previousTag ? Date.parse(run("git", ["log", "-1", "--format=%aI", previousTag])) : 0;
  const currentDate = Date.parse(run("git", ["log", "-1", "--format=%aI", currentTag]));
  const json = run("gh", [
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "merged",
    "--base",
    "main",
    "--limit",
    "100",
    "--json",
    "number,title,body,url,mergedAt,labels",
  ]);
  if (!json) return null;

  try {
    return JSON.parse(json)
      .filter((pr) => {
        const mergedAt = Date.parse(pr.mergedAt);
        return mergedAt > previousDate && mergedAt <= currentDate;
      })
      .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
  } catch {
    return null;
  }
}

function cleanTitle(subject) {
  return subject
    .replace(/^Merge pull request #\d+ from \S+\s*/i, "")
    .replace(/^Merge PR #\d+:\s*/i, "")
    .replace(/\s+\(#\d+\)$/i, "")
    .replace(/^(?:feat|fix|chore|docs|ci|build)(?:\([^)]*\))?:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sentenceFromTitle(title) {
  const cleaned = cleanTitle(title);
  if (/^macOS\b/.test(cleaned)) return cleaned;
  return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`;
}

function classify(entry) {
  const rawTitle = entry.title.toLowerCase();
  const title = cleanTitle(entry.title).toLowerCase();
  const labels = (entry.labels || []).map((label) => label.toLowerCase());
  if (
    labels.includes("dependencies") ||
    /^(?:chore|ci|build)(?:\([^)]*\))?:/.test(rawTitle) ||
    /^(?:bump|update)\b/.test(title) ||
    /\b(?:dependabot|toolchain|internal|ci|workflow)\b/.test(title)
  ) {
    return "internal";
  }
  if (
    /^fix(?:\([^)]*\))?:/.test(rawTitle) ||
    /^(?:fix|restore|prevent|correct|resolve|repair)\b/.test(title) ||
    /\bbug\b/.test(title)
  ) {
    return "fixes";
  }
  if (/^feat(?:\([^)]*\))?:/.test(rawTitle) || /^(?:add|introduce|support|implement|enable)\b/.test(title)) {
    return "new";
  }
  return "improvements";
}

function displayHeading(entry) {
  return sentenceFromTitle(entry.title);
}

function displayCopy(entry) {
  return entry.summary
    .map((item) => {
      const sentence = `${item.charAt(0).toUpperCase()}${item.slice(1)}`;
      return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
    })
    .join(" ");
}

function suffix(entry) {
  const parts = [];
  if (entry.pr) parts.push(`#${entry.pr}`);
  const refs = entry.refs.filter((ref) => ref !== entry.pr);
  if (refs.length === 1) {
    parts.push(`ref #${refs[0]}`);
  } else if (refs.length > 1) {
    parts.push(`refs ${refs.map((ref) => `#${ref}`).join(", ")}`);
  }
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function output(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const delimiter = `EOF_${name}_${Date.now()}`;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export function formatReleaseNotes(
  tag,
  previousTag,
  entries,
  repository = process.env.GITHUB_REPOSITORY || "kristofferR/Carrier",
) {
  const version = tag.replace(/^v/, "");
  const sections = {
    new: [],
    improvements: [],
    fixes: [],
    internal: [],
  };

  for (const entry of entries) {
    sections[classify(entry)].push(entry);
  }

  const releaseTitle = tag.startsWith("v") ? tag : `v${version}`;
  const lines = [];

  function appendSection(heading, items) {
    if (!items.length) return;
    lines.push(`## ${heading}`, "");
    for (const entry of items) {
      const copy = displayCopy(entry);
      lines.push(`- **${displayHeading(entry)}**${copy ? ` — ${copy}` : ""}${suffix(entry)}`);
    }
    lines.push("");
  }

  appendSection("What's New", sections.new);
  appendSection("Improvements", sections.improvements);
  appendSection("Bug Fixes", sections.fixes);
  appendSection("Internal", sections.internal);

  if (previousTag) {
    lines.push(`**Full changelog:** https://github.com/${repository}/compare/${previousTag}...${tag}`);
  }

  return { releaseTitle, releaseBody: lines.join("\n") };
}

function main() {
  const tag = process.argv[2] || process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
  const notesPath = process.argv[3] || "release-notes.md";
  if (!tag) {
    console.error("Usage: generate-release-notes.mjs <tag> [notes-path]");
    process.exit(1);
  }

  const previousTag = previousReleaseTag(tag);
  const range = previousTag ? `${previousTag}..${tag}` : tag;
  const commits = parseCommits(range).filter((commit) => !isNoiseSubject(commit.subject));
  const entries = [];
  const seenPrs = new Set();

  for (const pr of mergedPullRequests(previousTag, tag) || []) {
    const number = String(pr.number);
    seenPrs.add(number);
    entries.push({
      title: pr.title,
      pr: number,
      refs: issueRefs(pr.body || ""),
      summary: summaryBullets(pr.body || ""),
      labels: (pr.labels || []).map((label) => label.name),
    });
  }

  for (const commit of commits) {
    const pr = prNumberFromSubject(commit.subject);
    if (pr) {
      if (seenPrs.has(pr)) continue;
      seenPrs.add(pr);
      entries.push({
        title: commit.subject,
        pr,
        refs: [],
        summary: summaryBullets(commit.body),
        labels: [],
      });
      continue;
    }

    entries.push({
      title: commit.subject,
      pr: "",
      refs: issueRefs(`${commit.subject}\n${commit.body}`),
      summary: summaryBullets(commit.body),
      labels: [],
    });
  }

  const { releaseTitle, releaseBody } = formatReleaseNotes(tag, previousTag, entries);
  writeFileSync(notesPath, `${releaseBody}\n`);
  output("release_title", releaseTitle);
  output("release_body", releaseBody);

  console.log(releaseTitle);
  console.log(`Wrote ${notesPath}${previousTag ? ` from ${previousTag}..${tag}` : ""}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
