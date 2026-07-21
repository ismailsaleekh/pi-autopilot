// Reference existence (C3) + link/anchor resolution (C6).
//
// C3: every source path, backticked src/ path, and #anchor-free symbol mentioned in
//     a doc body — plus every covers_sources entry — must resolve on disk.
// C6: every intra-docs link, README→docs link, and manifest path must resolve to an
//     existing file (and, when present, an existing #anchor derived by the GitHub
//     heading-slug algorithm).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';

import { DOCS_DIR, PACKAGE_ROOT } from './config.mjs';

/** GitHub-flavored heading→anchor slug (deterministic). */
export function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/gu, '')
    .replace(/&[a-z]+;/gu, '')
    .replace(/[^\w\- ]/gu, '')
    .replace(/ /gu, '-');
}

/** Collect the set of anchors a markdown body exposes (from ATX headings). */
export function anchorsOf(markdown) {
  const anchors = new Set();
  const counts = new Map();
  for (const line of markdown.split('\n')) {
    const match = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/u);
    if (match === null) continue;
    const base = slugify(match[1]);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${String(seen)}`);
  }
  return anchors;
}

/**
 * Extract link targets from a body, ignoring code fences: Markdown links
 * `[text](target)` AND HTML image sources `<img src="target">`. Both must resolve
 * (C6), so a broken logo/image path fails the gate exactly like a broken doc link.
 */
export function extractLinks(markdown) {
  const withoutFences = markdown.replace(/```[\s\S]*?```/gu, (block) => block.replace(/[^\n]/gu, ' '));
  const links = [];
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/gu;
  let match;
  while ((match = linkPattern.exec(withoutFences)) !== null) {
    links.push(match[1].trim());
  }
  const imgPattern = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/giu;
  while ((match = imgPattern.exec(withoutFences)) !== null) {
    links.push(match[1].trim());
  }
  return links;
}

function isExternal(target) {
  return /^(?:https?:|mailto:)/u.test(target);
}

/**
 * Resolve every link in a doc/readme relative to its own path. Returns failure
 * strings. `fileAnchorCache` memoizes anchor sets per resolved file.
 */
export function resolveLinks(sourceRelPath, markdown, fileAnchorCache) {
  const failures = [];
  const baseDir = dirname(resolve(PACKAGE_ROOT, sourceRelPath));
  for (const rawTarget of extractLinks(markdown)) {
    if (isExternal(rawTarget)) continue;
    if (rawTarget.startsWith('#')) {
      const anchor = rawTarget.slice(1);
      const anchors = anchorsOf(markdown);
      if (!anchors.has(anchor)) failures.push(`${sourceRelPath}: intra-doc anchor "#${anchor}" does not resolve to a heading`);
      continue;
    }
    const [pathPart, anchorPart] = rawTarget.split('#');
    const resolved = resolve(baseDir, pathPart);
    const resolvedRel = posix.normalize(resolved.slice(PACKAGE_ROOT.length));
    if (!existsSync(resolved)) {
      failures.push(`${sourceRelPath}: link target "${rawTarget}" does not exist (${resolvedRel})`);
      continue;
    }
    if (anchorPart !== undefined && anchorPart.length > 0 && resolved.endsWith('.md')) {
      let anchors = fileAnchorCache.get(resolved);
      if (anchors === undefined) {
        anchors = anchorsOf(readFileSync(resolved, 'utf8'));
        fileAnchorCache.set(resolved, anchors);
      }
      if (!anchors.has(anchorPart)) failures.push(`${sourceRelPath}: link "${rawTarget}" anchor "#${anchorPart}" does not resolve in ${resolvedRel}`);
    }
  }
  return failures;
}

/**
 * C3 reference existence for a single doc. We check:
 *   - every covers_sources entry exists on disk,
 *   - every backticked `src/…(.ts|.js|/)` path in the body exists,
 *   - every `symbol#EXPORT` style ref in fact-pins already validated elsewhere.
 */
export function checkReferences(doc) {
  const failures = [];
  for (const source of doc.coversSources) {
    if (!existsSync(resolve(PACKAGE_ROOT, source))) {
      failures.push(`${doc.location}: covers_sources entry "${source}" does not exist`);
    }
  }
  const backtickedPaths = [...doc.body.matchAll(/`(src\/[A-Za-z0-9._\-/]+?(?:\.ts|\.js|\.mjs|\/)?)`/gu)].map((match) => match[1]);
  for (const rawPath of backtickedPaths) {
    const [pathOnly] = rawPath.split('#');
    const normalized = pathOnly.replace(/\/$/u, '');
    if (normalized.length === 0) continue;
    if (!existsSync(resolve(PACKAGE_ROOT, normalized))) {
      failures.push(`${doc.location}: referenced source path "${rawPath}" does not exist`);
    }
  }
  return failures;
}

export { DOCS_DIR };
