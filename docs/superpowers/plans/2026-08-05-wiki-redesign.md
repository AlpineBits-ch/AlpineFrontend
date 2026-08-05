# Wiki Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the guild wiki as a self-contained three-pane workspace with inline editing, search, internal linking, revision diffs and permission awareness.

**Architecture:** The wiki stops being a global side panel plus a squeezed content pane and becomes one grid that owns its own nav / article / context-rail layout. Read and edit share a single TipTap instance so no layout shift is possible. All derivable logic (diff, links, TOC, search scoring) lives in pure modules that are unit-tested without Angular; services and components consume them.

**Tech Stack:** Angular 21 (signals, standalone components), PrimeNG 21, Tailwind v4, TipTap 3 + `@tiptap/pm`, Vitest via `@angular/build:unit-test`.

**Design spec:** `docs/superpowers/specs/2026-08-05-wiki-redesign-design.md`

## Global Constraints

- **No new npm dependencies.** `@tiptap/pm` is installed and is the basis for the editor menus. `@tiptap/suggestion` and `@tiptap/extension-bubble-menu` are NOT installed and must not be added. The line diff is hand-written, not a `diff` package.
- **`ng test` type-checks the entire application.** A compile error in any file fails every test run, including files you did not touch. If a failure names a file outside `src/app/features/guild/components/wiki/`, it is not yours.
- **Do not modify any file under `src/app/features/guild/components/events-panel/`.** Another agent is actively working there with uncommitted changes.
- **Work on `main`. Commit after every task. Never `git reset`, `git rebase`, or force-push.**
- Tailwind tokens only — `bg-app-bg`, `bg-sidebar`, `bg-card`, `bg-hover`, `border-border`, `text-brand-dim`. Never raw hex like `bg-[#0d1117]`.
- Font sizes in rem-based Tailwind classes (`text-[0.8125rem]`), never px, so they scale with `--base-font-size`.
- Scrollable containers use `class="thin-scrollbar"` (defined in `src/styles.css`), never inline `scrollbar-width` styles. The existing wiki templates violate this repeatedly; fix it in files you touch.
- Angular: standalone components, `input()` / `output()` functions, `signal()` / `computed()`, `protected` members for template access. Match the surrounding style.
- PrimeNG buttons use `(onClick)`, not `(click)`.
- User-facing strings go through `| translate` with keys under `WIKI.*`. Locales are a git submodule — **the locale JSON changes land in their own commit** (Task 19), separate from the code referencing them.
- Test command: `./node_modules/.bin/ng test --include=<path-to-spec> --watch=false`

**Base directory for all wiki paths:** `src/app/features/guild/components/wiki/`

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `wiki-diff.ts` | Line-level LCS diff, pure | 1 |
| `wiki-links.ts` | `wiki:` href format/parse, backlink index, pure | 2 |
| `wiki-toc.ts` | Heading slugs and TOC assembly, pure | 3 |
| `wiki-search.ts` | Candidate scoring and ranking, pure | 4 |
| `wiki-drafts.service.ts` | localStorage draft persistence | 5 |
| `wiki-content-cache.service.ts` | Session page-content cache, throttled warm | 6 |
| `wiki-permissions.ts` | Wiki permission predicates, pure | 7 |
| `wiki.component.*` | Three-column grid shell, nav resize/collapse | 8 |
| `wiki-nav/wiki-nav.component.*` | Page + category tree (moved from `wiki-sidebar`) | 8 |
| `wiki-article/wiki-article.component.*` | Unified read + edit TipTap view | 10 |
| `wiki-article/wiki-extensions.ts` | TipTap extension list + link protocol config | 10 |
| `wiki-article/wiki-suggest.plugin.ts` | ProseMirror trigger plugin for `/` and `[[` | 11 |
| `wiki-article/wiki-bubble-menu.component.*` | Selection formatting menu | 11 |
| `wiki-article/wiki-slash-menu.component.*` | Block insertion menu | 11 |
| `wiki-rail/wiki-context-rail.component.*` | TOC, properties, backlinks, attribution | 13 |
| `wiki-breadcrumbs/wiki-breadcrumbs.component.*` | Breadcrumb bar + actions | 14 |
| `wiki-search/wiki-search-palette.component.*` | ⌘K overlay | 15 |
| `wiki-history/wiki-history.component.*` | Revisions + diff (existing, extended) | 17 |

Deleted in Task 9: `wiki-panel/`, `wiki-sidebar/` (contents moved to `wiki-nav/` in Task 8).

---

### Task 1: Line diff module

**Files:**
- Create: `src/app/features/guild/components/wiki/wiki-diff.ts`
- Test: `src/app/features/guild/components/wiki/wiki-diff.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type DiffOp = 'add' | 'del' | 'ctx'`, `interface DiffLine {type: DiffOp; text: string}`, `diffLines(before: string, after: string): DiffLine[]`, `interface DiffStat {added: number; removed: number}`, `diffStat(lines: DiffLine[]): DiffStat`. Used by Task 17.

- [ ] **Step 1: Write the failing test**

Create `wiki-diff.spec.ts`:

```ts
import {diffLines, diffStat} from './wiki-diff';

describe('diffLines', () => {
    it('reports every line as context when both sides are identical', () => {
        expect(diffLines('a\nb', 'a\nb')).toEqual([
            {type: 'ctx', text: 'a'},
            {type: 'ctx', text: 'b'},
        ]);
    });

    // '' must not become [''] via split, or an empty document reports one phantom line.
    it('treats an empty before side as pure addition', () => {
        expect(diffLines('', 'a')).toEqual([{type: 'add', text: 'a'}]);
    });

    it('treats an empty after side as pure deletion', () => {
        expect(diffLines('a', '')).toEqual([{type: 'del', text: 'a'}]);
    });

    it('reports nothing for two empty sides', () => {
        expect(diffLines('', '')).toEqual([]);
    });

    it('finds a line inserted in the middle', () => {
        expect(diffLines('a\nc', 'a\nb\nc')).toEqual([
            {type: 'ctx', text: 'a'},
            {type: 'add', text: 'b'},
            {type: 'ctx', text: 'c'},
        ]);
    });

    it('finds a line removed from the middle', () => {
        expect(diffLines('a\nb\nc', 'a\nc')).toEqual([
            {type: 'ctx', text: 'a'},
            {type: 'del', text: 'b'},
            {type: 'ctx', text: 'c'},
        ]);
    });

    it('reports a replaced line as a deletion followed by an addition', () => {
        expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([
            {type: 'ctx', text: 'a'},
            {type: 'del', text: 'b'},
            {type: 'add', text: 'x'},
            {type: 'ctx', text: 'c'},
        ]);
    });

    it('keeps the common subsequence when a block moves', () => {
        const result = diffLines('a\nb\nc', 'c\na\nb');
        expect(result.filter(l => l.type === 'ctx').map(l => l.text)).toEqual(['a', 'b']);
        expect(result.filter(l => l.type === 'add').map(l => l.text)).toEqual(['c']);
        expect(result.filter(l => l.type === 'del').map(l => l.text)).toEqual(['c']);
    });

    it('preserves blank lines inside content rather than collapsing them', () => {
        expect(diffLines('a\n\nb', 'a\n\nb')).toHaveLength(3);
    });
});

describe('diffStat', () => {
    it('counts additions and removals and ignores context', () => {
        expect(diffStat(diffLines('a\nb\nc', 'a\nx\nc'))).toEqual({added: 1, removed: 1});
    });

    it('reports zeroes for an unchanged document', () => {
        expect(diffStat(diffLines('a', 'a'))).toEqual({added: 0, removed: 0});
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/ng test --include=src/app/features/guild/components/wiki/wiki-diff.spec.ts --watch=false`
Expected: FAIL — cannot resolve `./wiki-diff`.

- [ ] **Step 3: Write the implementation**

Create `wiki-diff.ts`:

```ts
/**
 * Line-level diff over wiki page content.
 *
 * A classic LCS dynamic-programming table rather than Myers: page revisions are at most a few
 * hundred lines, where O(n*m) is imperceptible, and the table version is short enough to read.
 * Written by hand deliberately - pulling in a diff package for sixty lines is not worth the
 * dependency.
 */

export type DiffOp = 'add' | 'del' | 'ctx';

export interface DiffLine {
    type: DiffOp;
    text: string;
}

export interface DiffStat {
    added: number;
    removed: number;
}

/** `''.split('\n')` is `['']`, which would report a phantom line for an empty document. */
function toLines(text: string): string[] {
    return text === '' ? [] : text.split('\n');
}

export function diffLines(before: string, after: string): DiffLine[] {
    const a = toLines(before);
    const b = toLines(after);
    const m = a.length;
    const n = b.length;

    // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
    const lcs: number[][] = Array.from({length: m + 1}, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j]
                ? lcs[i + 1][j + 1] + 1
                : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }

    const out: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (a[i] === b[j]) {
            out.push({type: 'ctx', text: a[i]});
            i++;
            j++;
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            // Deletions are emitted before additions on a tie so a replaced line reads as
            // "was X, now Y" rather than the reverse.
            out.push({type: 'del', text: a[i]});
            i++;
        } else {
            out.push({type: 'add', text: b[j]});
            j++;
        }
    }
    while (i < m) out.push({type: 'del', text: a[i++]});
    while (j < n) out.push({type: 'add', text: b[j++]});
    return out;
}

export function diffStat(lines: DiffLine[]): DiffStat {
    return {
        added: lines.filter(l => l.type === 'add').length,
        removed: lines.filter(l => l.type === 'del').length,
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/ng test --include=src/app/features/guild/components/wiki/wiki-diff.spec.ts --watch=false`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/wiki/wiki-diff.ts src/app/features/guild/components/wiki/wiki-diff.spec.ts
git commit -m "feat(wiki): line-level diff for revision comparison"
```

---

### Task 2: Wiki link module

**Files:**
- Create: `src/app/features/guild/components/wiki/wiki-links.ts`
- Test: `src/app/features/guild/components/wiki/wiki-links.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `WIKI_LINK_PROTOCOL: 'wiki'`, `wikiHref(pageId: string): string`, `parseWikiHref(href: string | null | undefined): string | null`, `extractLinkedPageIds(markdown: string): string[]`, `buildBacklinkIndex(contentByPageId: ReadonlyMap<string, string>): Map<string, string[]>`. Used by Tasks 10, 12, 13.

- [ ] **Step 1: Write the failing test**

Create `wiki-links.spec.ts`:

```ts
import {buildBacklinkIndex, extractLinkedPageIds, parseWikiHref, wikiHref} from './wiki-links';

describe('wikiHref / parseWikiHref', () => {
    it('round-trips a page id', () => {
        expect(parseWikiHref(wikiHref('abc123'))).toBe('abc123');
    });

    it('ignores ordinary links', () => {
        expect(parseWikiHref('https://example.com')).toBeNull();
    });

    // A stored page could carry a null or absent href; treating that as a wiki link would
    // render every such link as broken.
    it('ignores null and undefined', () => {
        expect(parseWikiHref(null)).toBeNull();
        expect(parseWikiHref(undefined)).toBeNull();
    });

    it('ignores an empty wiki href with no id', () => {
        expect(parseWikiHref('wiki:')).toBeNull();
    });

    it('does not match a protocol that merely starts with wiki', () => {
        expect(parseWikiHref('wikipedia:Foo')).toBeNull();
    });
});

describe('extractLinkedPageIds', () => {
    it('finds a single markdown wiki link', () => {
        expect(extractLinkedPageIds('see [Setup](wiki:p1) for details')).toEqual(['p1']);
    });

    it('finds several links and de-duplicates repeats', () => {
        const md = '[A](wiki:p1) and [B](wiki:p2) and [A again](wiki:p1)';
        expect(extractLinkedPageIds(md).sort()).toEqual(['p1', 'p2']);
    });

    it('ignores ordinary markdown links', () => {
        expect(extractLinkedPageIds('[docs](https://example.com)')).toEqual([]);
    });

    it('returns nothing for empty content', () => {
        expect(extractLinkedPageIds('')).toEqual([]);
    });

    it('handles a link whose label contains brackets', () => {
        expect(extractLinkedPageIds('[a [nested] label](wiki:p9)')).toEqual(['p9']);
    });
});

describe('buildBacklinkIndex', () => {
    it('maps each target to the pages that link to it', () => {
        const index = buildBacklinkIndex(new Map([
            ['home', 'go to [Setup](wiki:setup)'],
            ['guide', 'also [Setup](wiki:setup) and [API](wiki:api)'],
            ['setup', 'no links here'],
        ]));
        expect(index.get('setup')?.sort()).toEqual(['guide', 'home']);
        expect(index.get('api')).toEqual(['guide']);
    });

    it('omits targets nothing links to', () => {
        expect(buildBacklinkIndex(new Map([['a', 'plain text']])).size).toBe(0);
    });

    // Otherwise a page that references itself claims a backlink from itself, which reads as
    // "1 page links here" on a page nothing links to.
    it('does not record a page as its own backlink', () => {
        const index = buildBacklinkIndex(new Map([['a', 'see [me](wiki:a)']]));
        expect(index.get('a')).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/ng test --include=src/app/features/guild/components/wiki/wiki-links.spec.ts --watch=false`
Expected: FAIL — cannot resolve `./wiki-links`.

- [ ] **Step 3: Write the implementation**

Create `wiki-links.ts`:

```ts
/**
 * Internal page links.
 *
 * A wiki link is an ordinary markdown link with a `wiki:<pageId>` href, not a custom TipTap node.
 * That choice is what lets links survive save/load for free: the existing markdown serializer
 * already round-trips link marks, so no custom parseMarkdown/renderMarkdown is needed, and the
 * content stays readable anywhere it is viewed outside the app.
 */

export const WIKI_LINK_PROTOCOL = 'wiki';

/** Anchored, so `wikipedia:` cannot match. Requires at least one id character. */
const WIKI_HREF_RE = /^wiki:(.+)$/;

/**
 * Matches the href half of a markdown link. The label is deliberately not captured - labels can
 * contain nested brackets, and matching only `](wiki:...)` sidesteps that entirely.
 */
const MD_WIKI_LINK_RE = /]\(wiki:([^)\s]+)\)/g;

export function wikiHref(pageId: string): string {
    return `${WIKI_LINK_PROTOCOL}:${pageId}`;
}

export function parseWikiHref(href: string | null | undefined): string | null {
    if (!href) return null;
    const match = WIKI_HREF_RE.exec(href);
    return match ? match[1] : null;
}

export function extractLinkedPageIds(markdown: string): string[] {
    const ids = new Set<string>();
    for (const match of markdown.matchAll(MD_WIKI_LINK_RE)) {
        ids.add(match[1]);
    }
    return [...ids];
}

/**
 * Inverts "page -> pages it links to" into "page -> pages that link to it".
 *
 * Self-links are dropped: a page that references itself would otherwise report a backlink from
 * itself, which reads as "1 page links here" on a page nothing actually links to.
 */
export function buildBacklinkIndex(
    contentByPageId: ReadonlyMap<string, string>,
): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const [sourceId, content] of contentByPageId) {
        for (const targetId of extractLinkedPageIds(content)) {
            if (targetId === sourceId) continue;
            const sources = index.get(targetId);
            if (sources) {
                if (!sources.includes(sourceId)) sources.push(sourceId);
            } else {
                index.set(targetId, [sourceId]);
            }
        }
    }
    return index;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/ng test --include=src/app/features/guild/components/wiki/wiki-links.spec.ts --watch=false`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/wiki/wiki-links.ts src/app/features/guild/components/wiki/wiki-links.spec.ts
git commit -m "feat(wiki): wiki: href helpers and backlink index"
```

---

### Task 3: Table-of-contents module

**Files:**
- Create: `src/app/features/guild/components/wiki/wiki-toc.ts`
- Test: `src/app/features/guild/components/wiki/wiki-toc.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface Heading {level: number; text: string}`, `interface TocEntry {id: string; text: string; level: number}`, `slugify(text: string): string`, `buildToc(headings: readonly Heading[]): TocEntry[]`. Used by Tasks 10, 13.

- [ ] **Step 1: Write the failing test**

Create `wiki-toc.spec.ts`:

```ts
import {buildToc, slugify} from './wiki-toc';

describe('slugify', () => {
    it('lowercases and hyphenates words', () => {
        expect(slugify('Getting Started')).toBe('getting-started');
    });

    it('strips punctuation', () => {
        expect(slugify("What's new?")).toBe('whats-new');
    });

    it('collapses runs of separators and trims the ends', () => {
        expect(slugify('  a --  b  ')).toBe('a-b');
    });

    // Headings can be pure emoji or CJK; an empty id would collide with every other empty id
    // and make anchors unusable.
    it('falls back to a stable placeholder when nothing survives', () => {
        expect(slugify('🎉')).toBe('section');
    });

    it('keeps digits', () => {
        expect(slugify('Step 2')).toBe('step-2');
    });
});

describe('buildToc', () => {
    it('assigns a slug id per heading', () => {
        expect(buildToc([{level: 1, text: 'Intro'}, {level: 2, text: 'Details'}])).toEqual([
            {id: 'intro', text: 'Intro', level: 1},
            {id: 'details', text: 'Details', level: 2},
        ]);
    });

    // Two "Notes" headings are common. Without suffixing, both anchors point at the first.
    it('suffixes duplicate slugs so every id is unique', () => {
        expect(buildToc([
            {level: 2, text: 'Notes'},
            {level: 2, text: 'Notes'},
            {level: 2, text: 'Notes'},
        ]).map(e => e.id)).toEqual(['notes', 'notes-2', 'notes-3']);
    });

    it('returns nothing for a document with no headings', () => {
        expect(buildToc([])).toEqual([]);
    });

    it('preserves the original heading text including punctuation', () => {
        expect(buildToc([{level: 3, text: "What's new?"}])[0].text).toBe("What's new?");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/ng test --include=src/app/features/guild/components/wiki/wiki-toc.spec.ts --watch=false`
Expected: FAIL — cannot resolve `./wiki-toc`.

- [ ] **Step 3: Write the implementation**

Create `wiki-toc.ts`:

```ts
/**
 * Table of contents.
 *
 * Takes already-extracted headings rather than a ProseMirror document, so the interesting part -
 * slug stability and collision handling - is testable without an editor instance. The component
 * owns the two-line walk that produces the Heading list.
 */

export interface Heading {
    level: number;
    text: string;
}

export interface TocEntry {
    id: string;
    text: string;
    level: number;
}

/** Anchors must survive a reload, so ids come from the text, never from a counter or random id. */
export function slugify(text: string): string {
    const slug = text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    // Emoji-only or non-Latin headings reduce to '', which would collide with every other
    // empty slug. 'section' plus the dedupe suffix below keeps them addressable.
    return slug || 'section';
}

export function buildToc(headings: readonly Heading[]): TocEntry[] {
    const seen = new Map<string, number>();
    return headings.map(heading => {
        const base = slugify(heading.text);
        const count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        return {
            id: count === 1 ? base : `${base}-${count}`,
            text: heading.text,
            level: heading.level,
        };
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/ng test --include=src/app/features/guild/components/wiki/wiki-toc.spec.ts --watch=false`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/wiki/wiki-toc.ts src/app/features/guild/components/wiki/wiki-toc.spec.ts
git commit -m "feat(wiki): stable heading slugs and TOC assembly"
```

---

### Task 4: Search scoring module

**Files:**
- Create: `src/app/features/guild/components/wiki/wiki-search.ts`
- Test: `src/app/features/guild/components/wiki/wiki-search.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface SearchCandidate {id: string; title: string; tags: readonly string[]; content?: string}`, `type MatchField = 'title' | 'tag' | 'content'`, `interface SearchHit {id: string; score: number; matchedIn: MatchField; snippet: string | null}`, `searchWiki(candidates: readonly SearchCandidate[], query: string, limit?: number): SearchHit[]`. Used by Task 15.

- [ ] **Step 1: Write the failing test**

Create `wiki-search.spec.ts`:

```ts
import {SearchCandidate, searchWiki} from './wiki-search';

function candidate(over: Partial<SearchCandidate> & {id: string}): SearchCandidate {
    return {title: over.id, tags: [], ...over};
}

describe('searchWiki', () => {
    it('returns nothing for an empty or whitespace query', () => {
        const items = [candidate({id: 'a', title: 'Alpha'})];
        expect(searchWiki(items, '')).toEqual([]);
        expect(searchWiki(items, '   ')).toEqual([]);
    });

    it('ranks an exact title above a prefix match', () => {
        const hits = searchWiki([
            candidate({id: 'p', title: 'Setup Guide'}),
            candidate({id: 'e', title: 'Setup'}),
        ], 'Setup');
        expect(hits.map(h => h.id)).toEqual(['e', 'p']);
    });

    it('ranks a title prefix above a mid-word substring', () => {
        const hits = searchWiki([
            candidate({id: 'sub', title: 'Advanced Setup'}),
            candidate({id: 'pre', title: 'Setup Notes'}),
        ], 'setup');
        expect(hits[0].id).toBe('pre');
    });

    it('ranks a title match above a tag match', () => {
        const hits = searchWiki([
            candidate({id: 'tag', title: 'Unrelated', tags: ['deploy']}),
            candidate({id: 'title', title: 'Deploy'}),
        ], 'deploy');
        expect(hits[0].id).toBe('title');
    });

    it('ranks a tag match above a content-only match', () => {
        const hits = searchWiki([
            candidate({id: 'body', title: 'Unrelated', content: 'we deploy on fridays'}),
            candidate({id: 'tag', title: 'Unrelated Too', tags: ['deploy']}),
        ], 'deploy');
        expect(hits[0].id).toBe('tag');
    });

    it('is case insensitive', () => {
        expect(searchWiki([candidate({id: 'a', title: 'Setup'})], 'SETUP')).toHaveLength(1);
    });

    it('reports which field matched', () => {
        expect(searchWiki([candidate({id: 'a', title: 'Setup'})], 'setup')[0].matchedIn).toBe('title');
        expect(searchWiki([candidate({id: 'b', title: 'X', tags: ['setup']})], 'setup')[0].matchedIn).toBe('tag');
    });

    it('returns a snippet around a content match and none for a title match', () => {
        const hits = searchWiki([
            candidate({id: 'a', title: 'X', content: 'lorem ipsum deploy dolor sit'}),
        ], 'deploy');
        expect(hits[0].snippet).toContain('deploy');
        expect(searchWiki([candidate({id: 'b', title: 'Deploy'})], 'deploy')[0].snippet).toBeNull();
    });

    it('matches a subsequence in the title when no substring matches', () => {
        // 'stp' appears in order inside 'Setup' but not contiguously.
        expect(searchWiki([candidate({id: 'a', title: 'Setup'})], 'stp')).toHaveLength(1);
    });

    it('excludes candidates that match nothing', () => {
        expect(searchWiki([candidate({id: 'a', title: 'Setup'})], 'zzzz')).toEqual([]);
    });

    it('breaks ties deterministically by shorter title then alphabetically', () => {
        const hits = searchWiki([
            candidate({id: 'long', title: 'Setup Guide Extended'}),
            candidate({id: 'b', title: 'Setup B'}),
            candidate({id: 'a', title: 'Setup A'}),
        ], 'setup');
        expect(hits.map(h => h.id)).toEqual(['a', 'b', 'long']);
    });

    it('honours the result limit', () => {
        const many = Array.from({length: 50}, (_, i) => candidate({id: `p${i}`, title: `Setup ${i}`}));
        expect(searchWiki(many, 'setup', 10)).toHaveLength(10);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/ng test --include=src/app/features/guild/components/wiki/wiki-search.spec.ts --watch=false`
Expected: FAIL — cannot resolve `./wiki-search`.

- [ ] **Step 3: Write the implementation**

Create `wiki-search.ts`:

```ts
/**
 * Search ranking.
 *
 * Two tiers, because `getWiki` returns summaries without content: titles and tags are always
 * available and score highest, while content is present only for pages the content cache has
 * fetched. Scores are fixed bands rather than a tuned relevance function - the point is that a
 * title beats a tag beats a body mention, predictably.
 */

export interface SearchCandidate {
    id: string;
    title: string;
    tags: readonly string[];
    content?: string;
}

export type MatchField = 'title' | 'tag' | 'content';

export interface SearchHit {
    id: string;
    score: number;
    matchedIn: MatchField;
    /** Context around a content match; null when the match was in the title or a tag. */
    snippet: string | null;
}

const SCORE_TITLE_EXACT = 1000;
const SCORE_TITLE_PREFIX = 800;
const SCORE_TITLE_WORD_PREFIX = 600;
const SCORE_TITLE_SUBSTRING = 400;
const SCORE_TAG_EXACT = 350;
const SCORE_TAG_PREFIX = 300;
const SCORE_TITLE_SUBSEQUENCE = 200;
const SCORE_CONTENT = 100;

const SNIPPET_RADIUS = 40;

/** True when every character of `query` appears in `text` in order, not necessarily adjacent. */
function isSubsequence(text: string, query: string): boolean {
    let index = 0;
    for (const char of text) {
        if (char === query[index]) index++;
        if (index === query.length) return true;
    }
    return query.length === 0;
}

function snippetAround(content: string, at: number, queryLength: number): string {
    const start = Math.max(0, at - SNIPPET_RADIUS);
    const end = Math.min(content.length, at + queryLength + SNIPPET_RADIUS);
    return `${start > 0 ? '…' : ''}${content.slice(start, end).trim()}${end < content.length ? '…' : ''}`;
}

function scoreOne(candidate: SearchCandidate, query: string): SearchHit | null {
    const title = candidate.title.toLowerCase();

    if (title === query) return {id: candidate.id, score: SCORE_TITLE_EXACT, matchedIn: 'title', snippet: null};
    if (title.startsWith(query)) return {id: candidate.id, score: SCORE_TITLE_PREFIX, matchedIn: 'title', snippet: null};
    if (title.split(/\s+/).some(word => word.startsWith(query))) {
        return {id: candidate.id, score: SCORE_TITLE_WORD_PREFIX, matchedIn: 'title', snippet: null};
    }
    if (title.includes(query)) return {id: candidate.id, score: SCORE_TITLE_SUBSTRING, matchedIn: 'title', snippet: null};

    for (const tag of candidate.tags) {
        const lower = tag.toLowerCase();
        if (lower === query) return {id: candidate.id, score: SCORE_TAG_EXACT, matchedIn: 'tag', snippet: null};
        if (lower.startsWith(query)) return {id: candidate.id, score: SCORE_TAG_PREFIX, matchedIn: 'tag', snippet: null};
    }

    if (isSubsequence(title, query)) {
        return {id: candidate.id, score: SCORE_TITLE_SUBSEQUENCE, matchedIn: 'title', snippet: null};
    }

    if (candidate.content) {
        const at = candidate.content.toLowerCase().indexOf(query);
        if (at !== -1) {
            return {
                id: candidate.id,
                score: SCORE_CONTENT,
                matchedIn: 'content',
                snippet: snippetAround(candidate.content, at, query.length),
            };
        }
    }

    return null;
}

export function searchWiki(
    candidates: readonly SearchCandidate[],
    query: string,
    limit = 25,
): SearchHit[] {
    const normalised = query.trim().toLowerCase();
    if (!normalised) return [];

    const titleById = new Map(candidates.map(c => [c.id, c.title]));

    return candidates
        .map(candidate => scoreOne(candidate, normalised))
        .filter((hit): hit is SearchHit => hit !== null)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            // Deterministic tie-break, so identical queries never reorder between renders.
            const titleA = titleById.get(a.id) ?? '';
            const titleB = titleById.get(b.id) ?? '';
            if (titleA.length !== titleB.length) return titleA.length - titleB.length;
            return titleA.localeCompare(titleB);
        })
        .slice(0, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/ng test --include=src/app/features/guild/components/wiki/wiki-search.spec.ts --watch=false`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/wiki/wiki-search.ts src/app/features/guild/components/wiki/wiki-search.spec.ts
git commit -m "feat(wiki): two-tier search ranking over titles, tags and content"
```

---

### Task 5: Draft persistence service

**Files:**
- Create: `src/app/features/guild/components/wiki/wiki-drafts.service.ts`
- Test: `src/app/features/guild/components/wiki/wiki-drafts.service.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface WikiDraft {title: string; content: string; categoryId?: string; parentPageId?: string; tags: string[]; isPinned: boolean; baseUpdatedAt: string | null; savedAt: number}`, and `WikiDraftsService` with `read(guildId: string, pageId: string | null): WikiDraft | null`, `write(guildId: string, pageId: string | null, draft: WikiDraft): void`, `clear(guildId: string, pageId: string | null): void`, `divergesFrom(draft: WikiDraft, title: string, content: string): boolean`. Used by Task 16.

- [ ] **Step 1: Write the failing test**

Create `wiki-drafts.service.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {WikiDraft, WikiDraftsService} from './wiki-drafts.service';

function draft(over: Partial<WikiDraft> = {}): WikiDraft {
    return {
        title: 'Setup',
        content: 'hello',
        tags: [],
        isPinned: false,
        baseUpdatedAt: null,
        savedAt: 1000,
        ...over,
    };
}

describe('WikiDraftsService', () => {
    let service: WikiDraftsService;

    beforeEach(() => {
        localStorage.clear();
        TestBed.configureTestingModule({});
        service = TestBed.inject(WikiDraftsService);
    });

    it('returns null when no draft was stored', () => {
        expect(service.read('g1', 'p1')).toBeNull();
    });

    it('round-trips a stored draft', () => {
        service.write('g1', 'p1', draft({content: 'edited'}));
        expect(service.read('g1', 'p1')?.content).toBe('edited');
    });

    it('keeps drafts for different pages apart', () => {
        service.write('g1', 'p1', draft({content: 'one'}));
        service.write('g1', 'p2', draft({content: 'two'}));
        expect(service.read('g1', 'p1')?.content).toBe('one');
        expect(service.read('g1', 'p2')?.content).toBe('two');
    });

    // Two guilds can each have an unsaved new page at once; a shared 'new' key would
    // silently serve one guild's draft to the other.
    it('keeps the new-page draft of different guilds apart', () => {
        service.write('g1', null, draft({title: 'From guild one'}));
        service.write('g2', null, draft({title: 'From guild two'}));
        expect(service.read('g1', null)?.title).toBe('From guild one');
        expect(service.read('g2', null)?.title).toBe('From guild two');
    });

    it('clears a draft', () => {
        service.write('g1', 'p1', draft());
        service.clear('g1', 'p1');
        expect(service.read('g1', 'p1')).toBeNull();
    });

    it('returns null and does not throw when the stored value is corrupt', () => {
        localStorage.setItem('wiki-draft:g1:p1', '{not json');
        expect(service.read('g1', 'p1')).toBeNull();
    });

    it('reports divergence when content differs from the server copy', () => {
        expect(service.divergesFrom(draft({content: 'edited'}), 'Setup', 'hello')).toBe(true);
    });

    it('reports divergence when only the title differs', () => {
        expect(service.divergesFrom(draft({title: 'Renamed'}), 'Setup', 'hello')).toBe(true);
    });

    // A draft written and then saved leaves an identical copy behind. Offering to "restore"
    // it would prompt on every visit for no reason.
    it('reports no divergence when the draft matches the server copy', () => {
        expect(service.divergesFrom(draft(), 'Setup', 'hello')).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/ng test --include=src/app/features/guild/components/wiki/wiki-drafts.service.spec.ts --watch=false`
Expected: FAIL — cannot resolve `./wiki-drafts.service`.

- [ ] **Step 3: Write the implementation**

Create `wiki-drafts.service.ts`:

```ts
import {Injectable} from '@angular/core';

/**
 * A local, unpublished edit.
 *
 * `baseUpdatedAt` records which server revision the draft was started from, so a draft can be
 * recognised as stale when the page has moved on underneath it.
 */
export interface WikiDraft {
    title: string;
    content: string;
    categoryId?: string;
    parentPageId?: string;
    tags: string[];
    isPinned: boolean;
    baseUpdatedAt: string | null;
    savedAt: number;
}

/**
 * Drafts survive navigation, reloads and crashes; they are never sent to the server on their own.
 * Publishing stays explicit, because autosaving to the server would mint a revision per keystroke
 * and turn the revision list into a keylog.
 */
@Injectable({providedIn: 'root'})
export class WikiDraftsService {
    /** Guild-scoped: two guilds can each hold an unsaved new page at the same time. */
    private key(guildId: string, pageId: string | null): string {
        return `wiki-draft:${guildId}:${pageId ?? 'new'}`;
    }

    read(guildId: string, pageId: string | null): WikiDraft | null {
        try {
            const raw = localStorage.getItem(this.key(guildId, pageId));
            return raw ? (JSON.parse(raw) as WikiDraft) : null;
        } catch {
            // Corrupt entry or storage unavailable. A missing draft is recoverable; a thrown
            // error while opening a page is not.
            return null;
        }
    }

    write(guildId: string, pageId: string | null, draft: WikiDraft): void {
        try {
            localStorage.setItem(this.key(guildId, pageId), JSON.stringify(draft));
        } catch {
            // Quota exceeded or storage disabled. Drafts degrade to off rather than
            // interrupting the edit; the status pill omits the draft state accordingly.
        }
    }

    clear(guildId: string, pageId: string | null): void {
        try {
            localStorage.removeItem(this.key(guildId, pageId));
        } catch {
            // Nothing to recover from - the draft is already unreachable.
        }
    }

    /** Whether restoring this draft would actually change anything the user can see. */
    divergesFrom(draft: WikiDraft, title: string, content: string): boolean {
        return draft.title !== title || draft.content !== content;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/ng test --include=src/app/features/guild/components/wiki/wiki-drafts.service.spec.ts --watch=false`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/wiki/wiki-drafts.service.ts src/app/features/guild/components/wiki/wiki-drafts.service.spec.ts
git commit -m "feat(wiki): localStorage draft persistence"
```

---

### Task 6: Page content cache

The server accepts `?includeContent=true` as of Echo `7ae3a50`, so warming the cache is **one
request**, not one per page. This task also plumbs `includeContent` and the new `summary` field
through the client DTOs and `WikiService`.

**Files:**
- Modify: `src/app/dtos/response/wiki.dto.ts`
- Modify: `src/app/dtos/request/wiki.dto.ts`
- Modify: `src/app/services/wiki.service.ts`
- Modify: `src/app/features/guild/components/wiki/wiki-state.service.ts`
- Create: `src/app/features/guild/components/wiki/wiki-content-cache.service.ts`
- Test: `src/app/features/guild/components/wiki/wiki-content-cache.service.spec.ts`

**Interfaces:**
- Consumes: `WikiService.getWikiWithContent(guildId)`.
- Produces: `WikiPageSummaryDto` gains `content?: string`; `UpdateWikiPageDto` gains `summary?: string`; `WikiService.getWikiWithContent(guildId: string)`. `WikiContentCacheService` with `content: Signal<ReadonlyMap<string, string>>`, `warming: Signal<boolean>`, `failed: Signal<boolean>`, `warmed: Signal<boolean>`, `put(pageId: string, content: string): void`, `invalidate(pageId: string): void`, `reset(): void`, `warm(guildId: string): void`. Used by Tasks 13 and 15.

- [ ] **Step 1: Extend the client DTOs and service**

In `src/app/dtos/response/wiki.dto.ts`, add to `WikiPageSummaryDto`:

```ts
/** Present only when the wiki was fetched with `includeContent`. */
content?: string;
```

In `src/app/dtos/request/wiki.dto.ts`, add to `UpdateWikiPageDto`:

```ts
/** Stored on the revision this update creates. Ignored when the content is unchanged. */
summary?: string;
```

In `src/app/services/wiki.service.ts`, add a **separate** method rather than a flag on `getWiki`:

```ts
/**
 * The content-bearing fetch, used to warm the search and backlink index.
 *
 * Deliberately not a flag on `getWiki`: that method swallows errors into an empty wiki so the
 * tree degrades to "no pages yet" rather than a broken view. Reusing it here would turn a failed
 * warm into a *successful* empty one, and search would report full-text coverage it does not
 * have. This one lets the error through so the caller can say so.
 */
getWikiWithContent(guildId: string): Observable<WikiDto> {
    return this.http.get<WikiDto>(`${this.base}/guilds/${guildId}/wiki`, {
        params: {includeContent: true},
    });
}
```

Note that `WikiPageDto extends WikiPageSummaryDto` and redeclares `content: string` as required —
that stays correct, since a single-page fetch always carries content.

- [ ] **Step 2: Write the failing test**

Create `wiki-content-cache.service.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {of, Subject, throwError} from 'rxjs';
import {WikiContentCacheService} from './wiki-content-cache.service';
import {WikiService} from '../../../../services/wiki.service';

function wikiWith(pages: {id: string; content?: string}[]) {
    return {id: 'w', guildId: 'g1', categories: [], pages} as never;
}

describe('WikiContentCacheService', () => {
    let service: WikiContentCacheService;
    let getWikiWithContent: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        getWikiWithContent = vi.fn(() => of(wikiWith([
            {id: 'p1', content: 'body one'},
            {id: 'p2', content: 'body two'},
        ])));
        TestBed.configureTestingModule({
            providers: [{provide: WikiService, useValue: {getWikiWithContent}}],
        });
        service = TestBed.inject(WikiContentCacheService);
    });

    it('starts empty, not warming and not warmed', () => {
        expect(service.content().size).toBe(0);
        expect(service.warming()).toBe(false);
        expect(service.warmed()).toBe(false);
    });

    it('stores content put into it directly as pages are opened', () => {
        service.put('p1', 'hello');
        expect(service.content().get('p1')).toBe('hello');
    });

    // One request for the whole wiki, not one per page.
    it('fills every page from a single request', () => {
        service.warm('g1');
        expect(getWikiWithContent).toHaveBeenCalledTimes(1);
        expect(getWikiWithContent).toHaveBeenCalledWith('g1');
        expect(service.content().get('p2')).toBe('body two');
        expect(service.warmed()).toBe(true);
    });

    it('clears warming once the request settles', () => {
        service.warm('g1');
        expect(service.warming()).toBe(false);
    });

    // The server omits content for a page it could not read; an empty string is a truthful
    // "nothing to search" whereas undefined would break the search candidate mapping.
    it('stores an empty body for a page returned without content', () => {
        getWikiWithContent.mockReturnValue(of(wikiWith([{id: 'p1'}])));
        service.warm('g1');
        expect(service.content().get('p1')).toBe('');
    });

    // A failed warm must not look like a completed one, or search silently reports title-only
    // results while presenting itself as full-text.
    it('records a failure and does not claim to be warmed', () => {
        getWikiWithContent.mockReturnValue(throwError(() => new Error('boom')));
        service.warm('g1');
        expect(service.warming()).toBe(false);
        expect(service.warmed()).toBe(false);
        expect(service.failed()).toBe(true);
    });

    it('allows a retry after a failure', () => {
        getWikiWithContent.mockReturnValueOnce(throwError(() => new Error('boom')));
        service.warm('g1');
        service.warm('g1');
        expect(getWikiWithContent).toHaveBeenCalledTimes(2);
        expect(service.warmed()).toBe(true);
        expect(service.failed()).toBe(false);
    });

    it('drops an invalidated page so it is fetched again', () => {
        service.put('p1', 'stale');
        service.invalidate('p1');
        expect(service.content().has('p1')).toBe(false);
    });

    it('empties everything on reset', () => {
        service.warm('g1');
        service.reset();
        expect(service.content().size).toBe(0);
        expect(service.warmed()).toBe(false);
    });

    it('does not warm twice once it has succeeded', () => {
        service.warm('g1');
        service.warm('g1');
        expect(getWikiWithContent).toHaveBeenCalledTimes(1);
    });

    it('ignores a second warm while one is in flight', () => {
        getWikiWithContent.mockReturnValue(new Subject<never>());
        service.warm('g1');
        service.warm('g1');
        expect(getWikiWithContent).toHaveBeenCalledTimes(1);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `./node_modules/.bin/ng test --include=src/app/features/guild/components/wiki/wiki-content-cache.service.spec.ts --watch=false`
Expected: FAIL — cannot resolve `./wiki-content-cache.service`.

- [ ] **Step 4: Write the implementation**

Create `wiki-content-cache.service.ts`:

```ts
import {inject, Injectable, signal} from '@angular/core';
import {WikiService} from '../../../../services/wiki.service';

/**
 * Session cache of page bodies.
 *
 * `getWiki` returns summaries without content by default, so full-text search and backlinks both
 * need the bodies and would otherwise each fetch them separately. One cache serves both: it fills
 * opportunistically as pages are opened, and can be warmed in full the first time a feature needs
 * complete coverage - never on wiki load, for a feature the user may not touch.
 *
 * The warm is a single `includeContent=true` request. It used to be one request per page; the
 * server gained the flag precisely so this could stop being N.
 */
@Injectable({providedIn: 'root'})
export class WikiContentCacheService {
    private readonly store = signal<ReadonlyMap<string, string>>(new Map());
    private readonly isWarming = signal(false);
    private readonly isWarmed = signal(false);
    private readonly didFail = signal(false);

    readonly content = this.store.asReadonly();
    readonly warming = this.isWarming.asReadonly();
    /** True only when every body is present, so callers can be honest about coverage. */
    readonly warmed = this.isWarmed.asReadonly();
    readonly failed = this.didFail.asReadonly();

    private readonly wikiService = inject(WikiService);

    put(pageId: string, content: string): void {
        this.store.update(map => new Map(map).set(pageId, content));
    }

    invalidate(pageId: string): void {
        this.store.update(map => {
            const next = new Map(map);
            next.delete(pageId);
            return next;
        });
        // One stale page is enough to make a backlink index wrong, so coverage is no longer
        // complete until the next warm.
        this.isWarmed.set(false);
    }

    reset(): void {
        this.store.set(new Map());
        this.isWarming.set(false);
        this.isWarmed.set(false);
        this.didFail.set(false);
    }

    /**
     * Loads every page body in one request. A completed warm is not repeated; a failed one is
     * retryable, because a failure that pinned the cache shut would leave search quietly
     * title-only for the rest of the session.
     */
    warm(guildId: string): void {
        if (this.isWarming() || this.isWarmed()) return;
        this.isWarming.set(true);
        this.didFail.set(false);
        this.wikiService.getWikiWithContent(guildId).subscribe({
            next: wiki => {
                this.store.update(map => {
                    const next = new Map(map);
                    // `?? ''` rather than a skip: an empty body is a truthful "nothing to
                    // search here", while a missing key would break candidate mapping.
                    for (const page of wiki.pages) next.set(page.id, page.content ?? '');
                    return next;
                });
                this.isWarming.set(false);
                this.isWarmed.set(true);
            },
            error: () => {
                this.isWarming.set(false);
                this.didFail.set(true);
            },
        });
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `./node_modules/.bin/ng test --include=src/app/features/guild/components/wiki/wiki-content-cache.service.spec.ts --watch=false`
Expected: PASS, 11 tests.

- [ ] **Step 6: Keep the cache honest as pages change**

A cache nothing invalidates goes stale, and stale bodies produce a backlink index that points at
links no longer there. Wire it into the existing websocket subscriptions in
`wiki-state.service.ts` — inject `WikiContentCacheService` and add one line to each handler that
already exists:

```ts
// in the wikiPageUpdatedObservable handler, alongside the existing loadWiki call
this.contentCache.invalidate(e.pageId);

// in the wikiPageDeletedObservable handler
this.contentCache.invalidate(e.pageId);
```

And in `initialize()`, inside the existing `if (this.guildId() !== guildId)` branch, so one
guild's bodies are never searched under another's name:

```ts
this.contentCache.reset();
```

Also call `this.contentCache.put(page.id, page.content)` in the `openPage` success handler — that
is the opportunistic fill, and it costs nothing since the content is already in hand.

- [ ] **Step 7: Commit**

```bash
git add src/app/dtos/request/wiki.dto.ts src/app/dtos/response/wiki.dto.ts src/app/services/wiki.service.ts src/app/features/guild/components/wiki/
git commit -m "feat(wiki): shared page-content cache warmed by one includeContent request"
```

---

### Task 7: Wiki permission predicates

**Files:**
- Create: `src/app/features/guild/components/wiki/wiki-permissions.ts`
- Test: `src/app/features/guild/components/wiki/wiki-permissions.spec.ts`

**Interfaces:**
- Consumes: `Permissions`, `hasPermission`, `PermissionValue` from `src/app/enums/permissions.enum.ts`.
- Produces: `interface WikiAbilities {canCreate: boolean; canEditAny: boolean; canEditOwn: boolean; canDelete: boolean; canManageStructure: boolean; canManageRevisions: boolean}`, `wikiAbilities(perms: PermissionValue): WikiAbilities`, `canEditPage(abilities: WikiAbilities, authorId: string, ownUserId: string | null): boolean`. Used by Task 18.

- [ ] **Step 1: Write the failing test**

Create `wiki-permissions.spec.ts`:

```ts
import {Permissions} from '../../../../enums/permissions.enum';
import {canEditPage, wikiAbilities} from './wiki-permissions';

describe('wikiAbilities', () => {
    it('grants nothing for no permissions', () => {
        expect(wikiAbilities(0n)).toEqual({
            canCreate: false,
            canEditAny: false,
            canEditOwn: false,
            canDelete: false,
            canManageStructure: false,
            canManageRevisions: false,
        });
    });

    it('maps each wiki permission to its ability', () => {
        expect(wikiAbilities(Permissions.CreateWikiPages).canCreate).toBe(true);
        expect(wikiAbilities(Permissions.EditAnyWikiPage).canEditAny).toBe(true);
        expect(wikiAbilities(Permissions.EditOwnWikiPages).canEditOwn).toBe(true);
        expect(wikiAbilities(Permissions.DeleteWikiPages).canDelete).toBe(true);
        expect(wikiAbilities(Permissions.ManageWikiStructure).canManageStructure).toBe(true);
        expect(wikiAbilities(Permissions.ManageWikiRevisions).canManageRevisions).toBe(true);
    });

    it('grants everything to Superadmin', () => {
        const abilities = wikiAbilities(Permissions.Superadmin);
        expect(Object.values(abilities).every(Boolean)).toBe(true);
    });

    it('does not leak one wiki permission into another', () => {
        expect(wikiAbilities(Permissions.CreateWikiPages).canDelete).toBe(false);
    });
});

describe('canEditPage', () => {
    const none = wikiAbilities(0n);
    const own = wikiAbilities(Permissions.EditOwnWikiPages);
    const any = wikiAbilities(Permissions.EditAnyWikiPage);

    it('lets an author edit their own page with EditOwnWikiPages', () => {
        expect(canEditPage(own, 'u1', 'u1')).toBe(true);
    });

    it('does not let EditOwnWikiPages edit somebody else', () => {
        expect(canEditPage(own, 'u2', 'u1')).toBe(false);
    });

    it('lets EditAnyWikiPage edit somebody else', () => {
        expect(canEditPage(any, 'u2', 'u1')).toBe(true);
    });

    it('denies everything with no edit permission at all', () => {
        expect(canEditPage(none, 'u1', 'u1')).toBe(false);
    });

    // Not-yet-loaded identity must fail closed, matching memberCanManageGuild: a control is
    // never briefly offered to somebody who turns out not to hold the permission.
    it('denies own-page editing while the own user id is still unknown', () => {
        expect(canEditPage(own, 'u1', null)).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/ng test --include=src/app/features/guild/components/wiki/wiki-permissions.spec.ts --watch=false`
Expected: FAIL — cannot resolve `./wiki-permissions`.

- [ ] **Step 3: Write the implementation**

Create `wiki-permissions.ts`:

```ts
import {hasPermission, Permissions, PermissionValue} from '../../../../enums/permissions.enum';

/**
 * What the current member may do in this wiki.
 *
 * The nine wiki permissions have existed in the enum since the feature shipped and were never
 * read by the UI - every member saw Edit and Delete. This is where that is fixed.
 */
export interface WikiAbilities {
    canCreate: boolean;
    canEditAny: boolean;
    canEditOwn: boolean;
    canDelete: boolean;
    canManageStructure: boolean;
    canManageRevisions: boolean;
}

export function wikiAbilities(perms: PermissionValue): WikiAbilities {
    const superadmin = hasPermission(perms, Permissions.Superadmin);
    const granted = (permission: PermissionValue) => superadmin || hasPermission(perms, permission);
    return {
        canCreate: granted(Permissions.CreateWikiPages),
        canEditAny: granted(Permissions.EditAnyWikiPage),
        canEditOwn: granted(Permissions.EditOwnWikiPages),
        canDelete: granted(Permissions.DeleteWikiPages),
        canManageStructure: granted(Permissions.ManageWikiStructure),
        canManageRevisions: granted(Permissions.ManageWikiRevisions),
    };
}

/**
 * A null `ownUserId` means "identity not loaded yet", not "not the author", and is denied.
 * Failing closed while loading is deliberate - see the note on `memberCanManageGuild`.
 */
export function canEditPage(
    abilities: WikiAbilities,
    authorId: string,
    ownUserId: string | null,
): boolean {
    if (abilities.canEditAny) return true;
    return abilities.canEditOwn && ownUserId !== null && ownUserId === authorId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/ng test --include=src/app/features/guild/components/wiki/wiki-permissions.spec.ts --watch=false`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/wiki/wiki-permissions.ts src/app/features/guild/components/wiki/wiki-permissions.spec.ts
git commit -m "feat(wiki): honour the wiki permission bits that already exist"
```

---

### Task 8: Three-column shell with the nav inside it

Moves the tree into the wiki itself. The old `wiki-panel` still renders at this point — the tree
appears twice for exactly one commit, which is ugly but never leaves the wiki unnavigable. Task 9
removes the panel.

**Files:**
- Create: `src/app/features/guild/components/wiki/wiki-nav/wiki-nav.component.ts` (moved from `wiki-sidebar/wiki-sidebar.component.ts`)
- Create: `src/app/features/guild/components/wiki/wiki-nav/wiki-nav.component.html` (moved from `wiki-sidebar/wiki-sidebar.component.html`)
- Modify: `src/app/features/guild/components/wiki/wiki.component.ts`
- Modify: `src/app/features/guild/components/wiki/wiki.component.html`
- Modify: `src/app/features/guild/components/wiki/wiki.component.css`

**Interfaces:**
- Consumes: `WikiStateService` (unchanged).
- Produces: `WikiNavComponent` (selector `app-wiki-nav`). `WikiComponent` gains `protected navWidth: WritableSignal<number>`, `protected navCollapsed: WritableSignal<boolean>`, `protected railVisible: WritableSignal<boolean>`.

- [ ] **Step 1: Move the sidebar component to `wiki-nav/`**

```bash
git mv src/app/features/guild/components/wiki/wiki-sidebar/wiki-sidebar.component.ts src/app/features/guild/components/wiki/wiki-nav/wiki-nav.component.ts
git mv src/app/features/guild/components/wiki/wiki-sidebar/wiki-sidebar.component.html src/app/features/guild/components/wiki/wiki-nav/wiki-nav.component.html
```

Rename the class and selector in `wiki-nav.component.ts`: `WikiSidebarComponent` → `WikiNavComponent`,
`selector: 'app-wiki-sidebar'` → `selector: 'app-wiki-nav'`, `templateUrl` → `'./wiki-nav.component.html'`.
Leave the tree, drag-and-drop, nest timer and `wouldCreateCycle` logic **exactly as it is** — this
step is a move, not a rewrite. Update the import in `wiki-panel.component.ts` to the new path and
class name so the app still compiles.

- [ ] **Step 2: Give the nav its own header and drop the inline scrollbar style**

In `wiki-nav.component.html`, replace the opening two elements:

```html
<div class="flex flex-col flex-1 min-h-0 select-none">

    <!-- Header: the wiki's own, now that there is no panel wrapper to carry it -->
    <div class="flex items-center gap-1.5 px-3 py-3 border-b border-white/[0.10] shrink-0">
        <i class="pi pi-book text-brand-dim text-sm shrink-0"></i>
        <span class="text-sm font-semibold text-white/90 truncate flex-1">Wiki</span>
        <p-button (onClick)="newPage()" [text]="true" icon="pi pi-plus" pTooltip="New page"
                  severity="secondary" size="small" tooltipPosition="bottom"/>
    </div>

    <!-- Tree -->
    <div class="flex-1 min-h-0 overflow-y-auto px-2 py-2 thin-scrollbar">
```

Add `Tooltip` to the component's `imports` array, and the method:

```ts
protected newPage(): void {
    this.state.openEditor();
}
```

- [ ] **Step 3: Write the shell template**

Replace `wiki.component.html` entirely:

```html
<div class="flex h-full min-w-0 overflow-hidden bg-app-bg">

    <!-- Nav -->
    @if (!navCollapsed()) {
        <div [style.width.px]="navWidth()"
             class="hidden lg:flex shrink-0 h-full bg-sidebar border-r border-white/[0.10]">
            <app-wiki-nav class="flex flex-col flex-1 min-h-0"/>
        </div>
        <!-- Drag handle. Sits in the gutter, widened by the ::after in the stylesheet so it is
             grabbable without drawing a 6px line down the layout. -->
        <div (mousedown)="startResize($event)"
             class="hidden lg:block wiki-resize-handle shrink-0"></div>
    }

    <!-- Article column -->
    <div class="flex-1 min-w-0 flex flex-col h-full overflow-hidden">
        @if (navCollapsed()) {
            <button (click)="navCollapsed.set(false)"
                    class="absolute left-2 top-2 z-10 w-7 h-7 rounded-lg bg-card border border-white/[0.10]
                           text-white/45 hover:text-white/80 cursor-pointer flex items-center justify-center"
                    title="Show pages">
                <i class="pi pi-angle-right text-[0.75rem]"></i>
            </button>
        }

        @switch (state.wikiView()) {
            @case ('home') {
                <app-wiki-home (newPage)="state.openEditor()"
                               (openPage)="state.openPage($event)"
                               [wiki]="state.wiki()"
                               class="flex-1 min-h-0"/>
            }
            @case ('page') {
                @if (state.pageLoading()) {
                    <div class="flex-1 flex flex-col items-center justify-center gap-3 text-white/20">
                        <i class="pi pi-spin pi-spinner text-2xl"></i>
                        <span class="text-sm">Loading page…</span>
                    </div>
                } @else if (state.selectedPage(); as page) {
                    <app-wiki-page-view (deleted)="state.afterDeleted()"
                                        (edit)="state.openEditor($event)"
                                        (history)="state.openHistory()"
                                        [guildId]="guildId()"
                                        [page]="page"
                                        class="flex-1 min-h-0"/>
                }
            }
            @case ('editor') {
                <app-wiki-editor (cancelled)="state.cancelEditor()"
                                 (saved)="onEditorSaved($event)"
                                 [guildId]="guildId()"
                                 [page]="state.editingPage()"
                                 [wiki]="state.wiki()"
                                 class="flex-1 min-h-0"/>
            }
            @case ('history') {
                @if (state.selectedPage(); as page) {
                    <app-wiki-history (back)="state.wikiView.set('page')"
                                      (restored)="state.afterRestored($event)"
                                      [guildId]="guildId()"
                                      [page]="page"
                                      class="flex-1 min-h-0"/>
                }
            }
        }
    </div>
</div>
```

- [ ] **Step 4: Add resize state to the component**

Replace `wiki.component.ts`:

```ts
import {Component, effect, inject, input, signal} from '@angular/core';
import {WikiStateService} from './wiki-state.service';
import {WikiNavComponent} from './wiki-nav/wiki-nav.component';
import {WikiPageViewComponent} from './wiki-page-view/wiki-page-view.component';
import {WikiEditorComponent} from './wiki-editor/wiki-editor.component';
import {WikiHistoryComponent} from './wiki-history/wiki-history.component';
import {WikiHomeComponent} from './wiki-home/wiki-home.component';
import {WikiPageDto} from '../../../../dtos/response/wiki.dto';

const NAV_WIDTH_KEY = 'wiki-nav-width';
const NAV_WIDTH_DEFAULT = 260;
const NAV_WIDTH_MIN = 200;
const NAV_WIDTH_MAX = 420;

@Component({
    selector: 'app-wiki',
    imports: [
        WikiNavComponent, WikiHomeComponent, WikiPageViewComponent,
        WikiEditorComponent, WikiHistoryComponent,
    ],
    templateUrl: './wiki.component.html',
    styleUrl: './wiki.component.css',
    host: {class: 'relative flex flex-1 min-w-0 h-full overflow-hidden'},
})
export class WikiComponent {
    readonly guildId = input.required<string>();

    protected readonly state = inject(WikiStateService);
    protected readonly navWidth = signal(readStoredWidth());
    protected readonly navCollapsed = signal(false);

    constructor() {
        effect(() => {
            const id = this.guildId();
            if (id) this.state.initialize(id);
        });
    }

    protected onEditorSaved(page: WikiPageDto): void {
        this.state.afterSaved(page);
    }

    /**
     * Pointer-move resize on document rather than the handle: the pointer routinely outruns a
     * 6px target during a drag, and listening on the handle alone drops the gesture the moment
     * it does.
     */
    protected startResize(event: MouseEvent): void {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = this.navWidth();

        const onMove = (move: MouseEvent) => {
            const next = Math.min(NAV_WIDTH_MAX, Math.max(NAV_WIDTH_MIN, startWidth + move.clientX - startX));
            this.navWidth.set(next);
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.userSelect = '';
            try {
                localStorage.setItem(NAV_WIDTH_KEY, String(this.navWidth()));
            } catch {
                // Width simply does not persist. Not worth surfacing.
            }
        };
        // Without this the drag selects the page text it passes over.
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }
}

function readStoredWidth(): number {
    try {
        const stored = Number(localStorage.getItem(NAV_WIDTH_KEY));
        return Number.isFinite(stored) && stored >= NAV_WIDTH_MIN && stored <= NAV_WIDTH_MAX
            ? stored
            : NAV_WIDTH_DEFAULT;
    } catch {
        return NAV_WIDTH_DEFAULT;
    }
}
```

- [ ] **Step 5: Style the resize handle**

Replace `wiki.component.css`:

```css
/* A 1px seam that is 9px grabbable. Widening the element itself would open a visible gutter. */
.wiki-resize-handle {
    width: 1px;
    cursor: col-resize;
    position: relative;
    background: transparent;
    transition: background 0.12s;
}

.wiki-resize-handle::after {
    content: '';
    position: absolute;
    inset-block: 0;
    inset-inline-start: -4px;
    width: 9px;
}

.wiki-resize-handle:hover {
    background: var(--color-brand-dim);
}
```

- [ ] **Step 6: Verify it compiles and behaves**

Run: `./node_modules/.bin/ng build --configuration development`
Expected: build succeeds.

Then start the app (`bun run start`), open a guild with the Wiki module, and confirm:
- the tree appears inside the wiki pane (and, for this one commit, also in the old panel),
- dragging the seam resizes the tree between 200 and 420px,
- the width survives a reload.

- [ ] **Step 7: Commit**

```bash
git add src/app/features/guild/components/wiki/
git commit -m "feat(wiki): move the page tree inside a resizable wiki shell"
```

---

### Task 9: Delete the wiki side panel

**Files:**
- Delete: `src/app/features/guild/components/wiki/wiki-panel/wiki-panel.component.ts`
- Delete: `src/app/features/guild/components/wiki/wiki-panel/wiki-panel.component.html`
- Modify: `src/app/features/main-page/main-page.component.html:36-39`
- Modify: `src/app/features/main-page/main-page.component.ts:58-59,108-109`
- Modify: `src/app/features/main-page/navigation.service.ts`
- Modify: `src/app/features/main-page/navigation.service.spec.ts:126-138`

**Interfaces:**
- Consumes: nothing new.
- Produces: `NavigationService` loses `wikiPanelGuildId`, `closeWikiPanel()` and `showWikiContent()`. `openWiki(guildId: string): void` remains and now only sets `mainView`.

> **Conflict warning.** `navigation.service.ts` is also touched by concurrent events-panel work.
> Keep this commit small and land it promptly. If `git status` shows uncommitted changes in
> `events-panel/`, leave them alone — they are not yours.

- [ ] **Step 1: Update the navigation service**

In `navigation.service.ts`:
- Delete the `wikiPanelGuildId` signal (`:41`) and every write to it (`:93`, `:133`, `:142`, `:186`, `:201`, `:238`, `:304`).
- Delete `closeWikiPanel()` (`:218-221`) and `showWikiContent()` (`:213-215`).
- In `openWiki`, keep only the `mainView` assignment:

```ts
openWiki(guildId: string): void {
    const current = this.mainView();
    if (current.type !== 'wiki' || current.guildId !== guildId) {
        this.mainView.set({type: 'wiki', guildId});
    }
}
```

- Delete the comment block at `:177-181` about the wiki and events panels sharing a slot, and the
  `this.wikiPanelGuildId.set(null)` it guards. Replace the comment at `:233` with:

```ts
/** The events panel has no dedicated main view, so opening and closing both go through here. */
```

and drop the `if (next) this.wikiPanelGuildId.set(null);` line beneath it — the wiki no longer
occupies that slot, so an events panel and a wiki main view can coexist.

- At `:302-304`, delete the panel line and its comment, keeping the `mainView` restore.

- [ ] **Step 2: Update the navigation spec**

Replace the test at `navigation.service.spec.ts:126`:

```ts
it('opens the wiki as the main view', () => {
    nav.openWiki('g1');
    expect(nav.mainView()).toEqual({type: 'wiki', guildId: 'g1'});
});

// The wiki used to occupy the same slot as the events panel and had to close it. It no longer
// does, so both can be open at once.
it('leaves the events panel open when the wiki is opened', () => {
    nav.toggleEventsPanel('g1');
    const eventsOpen = nav.eventsPanelGuildId();
    nav.openWiki('g1');
    expect(nav.eventsPanelGuildId()).toBe(eventsOpen);
});
```

Adjust the second test's setup to whatever the existing spec's events-panel helper is named; if the
spec has no events-panel coverage, omit that test rather than inventing an API.

- [ ] **Step 3: Remove the panel from the main page**

In `main-page.component.html`, delete lines 36-39 (the `@if (navService.wikiPanelGuildId())` block
and its comment). In `main-page.component.ts`, delete the `WikiPanelComponent` import (`:59`) and
its entry in `imports` (`:109`).

- [ ] **Step 4: Delete the panel component and fix remaining references**

```bash
git rm -r src/app/features/guild/components/wiki/wiki-panel
```

Then remove every remaining `showWikiContent(...)` call in `wiki-nav.component.ts` (in `goHome`,
`goPage`, `onCategoryContextMenu`, `onPageContextMenu`) — the nav now lives inside the wiki, so the
main view is already the wiki and nothing needs switching. Drop the now-unused `NavigationService`
injection from that component.

- [ ] **Step 5: Verify**

Run: `./node_modules/.bin/ng test --include=src/app/features/main-page/navigation.service.spec.ts --watch=false`
Expected: PASS.

Run: `./node_modules/.bin/ng build --configuration development`
Expected: build succeeds with no reference to `wikiPanelGuildId` or `WikiPanelComponent`.

Confirm in the app: opening the wiki no longer inserts a third sidebar, and the article pane starts
immediately after the channel list.

- [ ] **Step 6: Commit**

```bash
git add -A src/app/features/main-page src/app/features/guild/components/wiki
git commit -m "refactor(wiki): drop the global wiki side panel"
```

---

### Task 10: Unified read/edit article view

The core of the redesign: one TipTap instance, `setEditable()` toggled, title as the first line of
the document body. This replaces both `wiki-page-view` and `wiki-editor`.

**Files:**
- Create: `src/app/features/guild/components/wiki/wiki-article/wiki-extensions.ts`
- Create: `src/app/features/guild/components/wiki/wiki-article/wiki-article.component.ts`
- Create: `src/app/features/guild/components/wiki/wiki-article/wiki-article.component.html`
- Create: `src/app/features/guild/components/wiki/wiki-article/wiki-article.component.css`
- Modify: `src/app/features/guild/components/wiki/wiki.component.html`
- Modify: `src/app/features/guild/components/wiki/wiki.component.ts`

**Interfaces:**
- Consumes: `Heading` from `wiki-toc.ts`, `WIKI_LINK_PROTOCOL` from `wiki-links.ts`.
- Produces: `wikiExtensions(placeholder: string): Extensions`, and `WikiArticleComponent` (selector `app-wiki-article`) with inputs `page: WikiPageDto | null`, `wiki: WikiDto | null`, `guildId: string`, `editing: boolean`; outputs `saved: WikiPageDto`, `cancelled: void`, `headingsChanged: Heading[]`, `wikiLinkClicked: string`. Used by Tasks 11, 12, 13, 16.

- [ ] **Step 1: Write the extension list**

Create `wiki-article/wiki-extensions.ts`:

```ts
import {Extensions} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';
import {Table} from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import {Markdown} from '@tiptap/markdown';
import {WIKI_LINK_PROTOCOL} from '../wiki-links';

/**
 * The one extension list, shared by read and edit mode.
 *
 * Read mode is the same editor with `setEditable(false)`, not a separate render path - that is
 * what makes "no layout shift between read and edit" structural rather than a pair of
 * stylesheets that have to be kept in agreement.
 *
 * Sanitisation comes from the schema: a node or mark with no extension here is dropped at parse
 * time. The one thing a schema does not constrain is mark attributes, hence the explicit protocol
 * allowlist on Link - without it a stored `javascript:` href would survive into a live anchor.
 */
export function wikiExtensions(placeholder: string): Extensions {
    return [
        StarterKit.configure({
            trailingNode: {notAfter: ['taskList', 'bulletList', 'orderedList']},
        }),
        Underline,
        Link.configure({
            openOnClick: false,
            protocols: ['http', 'https', 'mailto', WIKI_LINK_PROTOCOL],
            // linkify would happily autolink a bare `wiki:` string typed as prose.
            shouldAutoLink: url => !url.startsWith(`${WIKI_LINK_PROTOCOL}:`),
        }),
        Placeholder.configure({placeholder}),
        Table.configure({resizable: false}),
        TableRow,
        TableHeader,
        TableCell,
        Image.configure({inline: false, allowBase64: false}),
        TaskList,
        TaskItem.configure({nested: false, HTMLAttributes: {'data-type': 'taskItem'}}),
        Markdown,
    ];
}
```

- [ ] **Step 2: Write the article template**

Create `wiki-article/wiki-article.component.html`:

```html
<div class="flex flex-col h-full min-w-0">

    <!-- Body. The padding here is the ONLY padding for both modes: read and edit render the same
         element, so there is no second value that could drift out of step. -->
    <div class="flex-1 min-h-0 overflow-y-auto thin-scrollbar" #scrollEl>
        <div class="mx-auto w-full max-w-[68ch] px-8 py-10">

            <!-- Title. A separate DTO field rendered as the first line of the body, so the
                 header above can stay a slim breadcrumb bar. -->
            <input (ngModelChange)="title.set($event)"
                   [ngModel]="title()"
                   [readOnly]="!editing()"
                   class="w-full bg-transparent border-0 outline-none text-[2rem] font-bold
                          text-white/90 placeholder-white/20 mb-2 leading-tight"
                   [class.cursor-default]="!editing()"
                   placeholder="Untitled"/>

            <div #editorEl class="wiki-content wiki-article-body"></div>
        </div>
    </div>
</div>

<input #fileInputEl (change)="onFilesSelected($event)"
       accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip,.rar"
       class="hidden" multiple type="file"/>
```

- [ ] **Step 3: Write the article component**

Create `wiki-article/wiki-article.component.ts`:

```ts
import {
    AfterViewInit, Component, effect, ElementRef, inject, input,
    OnDestroy, output, signal, ViewChild,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Editor} from '@tiptap/core';
import {WikiDto, WikiPageDto} from '../../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../../services/wiki.service';
import {FileService} from '../../../../../services/file.service';
import {Heading} from '../wiki-toc';
import {parseWikiHref} from '../wiki-links';
import {wikiExtensions} from './wiki-extensions';

@Component({
    selector: 'app-wiki-article',
    imports: [FormsModule],
    templateUrl: './wiki-article.component.html',
    styleUrl: './wiki-article.component.css',
    host: {class: 'flex flex-col flex-1 min-h-0 overflow-hidden'},
})
export class WikiArticleComponent implements AfterViewInit, OnDestroy {
    readonly page = input<WikiPageDto | null>(null);
    readonly wiki = input<WikiDto | null>(null);
    readonly guildId = input.required<string>();
    readonly editing = input(false);

    readonly saved = output<WikiPageDto>();
    readonly cancelled = output<void>();
    readonly headingsChanged = output<Heading[]>();
    readonly wikiLinkClicked = output<string>();
    readonly dirtyChanged = output<boolean>();

    @ViewChild('editorEl') editorEl?: ElementRef<HTMLDivElement>;
    @ViewChild('fileInputEl') fileInputEl?: ElementRef<HTMLInputElement>;

    protected readonly title = signal('');
    protected readonly saving = signal(false);

    private readonly wikiService = inject(WikiService);
    private readonly fileService = inject(FileService);
    private editor?: Editor;
    private clickHandler?: (e: MouseEvent) => void;

    constructor() {
        // Loading a different page replaces the document; toggling editing must not.
        effect(() => {
            const page = this.page();
            this.title.set(page?.title ?? '');
            if (this.editor) this.setContent(page?.content ?? '');
        });

        effect(() => {
            this.editor?.setEditable(this.editing());
        });
    }

    ngAfterViewInit(): void {
        if (!this.editorEl) return;
        this.editor = new Editor({
            element: this.editorEl.nativeElement,
            extensions: wikiExtensions('Start writing…'),
            editable: this.editing(),
            content: '',
            onUpdate: () => {
                this.dirtyChanged.emit(true);
                this.emitHeadings();
            },
        });
        this.setContent(this.page()?.content ?? '');

        // Read mode keeps live anchors, so wiki: links must be intercepted before the browser
        // tries to resolve a protocol it does not know.
        this.clickHandler = (event: MouseEvent) => {
            const anchor = (event.target as HTMLElement).closest('a');
            if (!anchor) return;
            const pageId = parseWikiHref(anchor.getAttribute('href'));
            if (!pageId) return;
            event.preventDefault();
            this.wikiLinkClicked.emit(pageId);
        };
        this.editorEl.nativeElement.addEventListener('click', this.clickHandler);
    }

    ngOnDestroy(): void {
        if (this.clickHandler) {
            this.editorEl?.nativeElement.removeEventListener('click', this.clickHandler);
        }
        this.editor?.destroy();
    }

    /** The live editor, for the menu components in Task 11. */
    get instance(): Editor | undefined {
        return this.editor;
    }

    markdown(): string {
        return (this.editor as unknown as {getMarkdown(): string} | undefined)?.getMarkdown() ?? '';
    }

    save(): void {
        if (this.saving() || !this.title().trim()) return;
        this.saving.set(true);
        const base = {title: this.title().trim(), content: this.markdown()};
        const editingId = this.page()?.id;
        const request = editingId
            ? this.wikiService.updatePage(this.guildId(), editingId, base)
            : this.wikiService.createPage(this.guildId(), base);
        request.subscribe({
            next: page => {
                this.saving.set(false);
                this.dirtyChanged.emit(false);
                this.saved.emit(page);
            },
            error: () => this.saving.set(false),
        });
    }

    protected onFilesSelected(event: Event): void {
        const input = event.target as HTMLInputElement;
        const files = input.files ? Array.from(input.files) : [];
        input.value = '';
        for (const file of files) this.uploadFile(file);
    }

    private uploadFile(file: File): void {
        if (!file.type.startsWith('image/')) return;
        const blobUrl = URL.createObjectURL(file);
        this.editor?.chain().focus().setImage({src: blobUrl, alt: file.name}).run();
        this.fileService.uploadFile(file).subscribe({
            next: attachment => {
                this.replaceImageSrc(blobUrl, attachment.url, attachment.fileName);
            },
            error: () => this.replaceImageSrc(blobUrl, '', ''),
        });
    }

    private replaceImageSrc(blobUrl: string, newSrc: string, alt: string): void {
        const editor = this.editor;
        if (!editor) return;
        const tr = editor.state.tr;
        let changed = false;
        editor.state.doc.descendants((node, pos) => {
            if (node.type.name === 'image' && node.attrs['src'] === blobUrl) {
                if (newSrc) {
                    tr.setNodeMarkup(pos, undefined, {...node.attrs, src: newSrc, alt});
                } else {
                    tr.delete(pos, pos + node.nodeSize);
                }
                changed = true;
                return false;
            }
            return true;
        });
        if (changed) editor.view.dispatch(tr);
        URL.revokeObjectURL(blobUrl);
    }

    /** Content is markdown, except for legacy pages saved as HTML before the markdown switch. */
    private setContent(content: string): void {
        if (!this.editor) return;
        if (!content) {
            this.editor.commands.setContent('');
        } else if (content.trimStart().startsWith('<')) {
            this.editor.commands.setContent(content);
        } else {
            this.editor.commands.setContent(content, {contentType: 'markdown'} as never);
        }
        this.emitHeadings();
    }

    private emitHeadings(): void {
        const headings: Heading[] = [];
        this.editor?.state.doc.descendants(node => {
            if (node.type.name === 'heading') {
                headings.push({level: node.attrs['level'] as number, text: node.textContent});
            }
            return true;
        });
        this.headingsChanged.emit(headings);
    }
}
```

- [ ] **Step 4: Style the article body**

Create `wiki-article/wiki-article.component.css`:

```css
/* The editable surface must not draw a focus ring - in read mode it is not a control, and in
   edit mode the caret is the affordance. */
.wiki-article-body :global(.ProseMirror) {
    outline: none;
    min-height: 12rem;
}

/* Broken internal links. Styled by the attribute the renderer sets in Task 12 rather than by a
   class, so it survives a markdown round trip. */
.wiki-article-body :global(a[data-wiki-broken='true']) {
    color: var(--color-offline);
    text-decoration-style: dashed;
}
```

- [ ] **Step 5: Swap the article into the shell**

In `wiki.component.html`, replace the `'page'` and `'editor'` cases with a single article, keeping
the loading branch:

```html
@case ('page') {
    @if (state.pageLoading()) {
        <div class="flex-1 flex flex-col items-center justify-center gap-3 text-white/20">
            <i class="pi pi-spin pi-spinner text-2xl"></i>
            <span class="text-sm">Loading page…</span>
        </div>
    } @else if (state.selectedPage(); as page) {
        <app-wiki-article (saved)="onEditorSaved($event)"
                          (wikiLinkClicked)="openLinkedPage($event)"
                          [editing]="state.wikiView() === 'editor'"
                          [guildId]="guildId()"
                          [page]="page"
                          [wiki]="state.wiki()"
                          class="flex-1 min-h-0"/>
    }
}
@case ('editor') {
    <app-wiki-article (cancelled)="state.cancelEditor()"
                      (saved)="onEditorSaved($event)"
                      (wikiLinkClicked)="openLinkedPage($event)"
                      [editing]="true"
                      [guildId]="guildId()"
                      [page]="state.editingPage()"
                      [wiki]="state.wiki()"
                      class="flex-1 min-h-0"/>
}
```

In `wiki.component.ts`, swap `WikiPageViewComponent` and `WikiEditorComponent` for
`WikiArticleComponent` in the imports, and add:

```ts
protected openLinkedPage(pageId: string): void {
    const summary = this.state.wiki()?.pages.find(p => p.id === pageId);
    if (summary) this.state.openPage(summary);
}
```

- [ ] **Step 6: Verify**

Run: `./node_modules/.bin/ng build --configuration development`
Expected: build succeeds.

In the app, confirm the load-bearing behaviour: open a page, note where a line of text sits, press
Edit, and confirm **the text does not move by a single pixel**. That is the whole point of this
task; if it moves, the two modes are not sharing one element and something in Step 5 is wrong.

- [ ] **Step 7: Commit**

```bash
git add src/app/features/guild/components/wiki/
git commit -m "feat(wiki): one TipTap instance for both reading and editing"
```

---

### Task 11: Bubble menu and slash menu

**Files:**
- Create: `src/app/features/guild/components/wiki/wiki-article/wiki-suggest.plugin.ts`
- Create: `src/app/features/guild/components/wiki/wiki-article/wiki-bubble-menu.component.ts`
- Create: `src/app/features/guild/components/wiki/wiki-article/wiki-slash-menu.component.ts`
- Test: `src/app/features/guild/components/wiki/wiki-article/wiki-suggest.plugin.spec.ts`
- Modify: `src/app/features/guild/components/wiki/wiki-article/wiki-article.component.html`
- Modify: `src/app/features/guild/components/wiki/wiki-article/wiki-article.component.ts`

**Interfaces:**
- Consumes: `Editor` from Task 10's `WikiArticleComponent.instance`.
- Produces: `interface SuggestState {trigger: '/' | '[['; query: string; from: number} | null`, `matchTrigger(textBefore: string): SuggestState | null`, `wikiSuggestPlugin(onChange: (state: SuggestState) => void): Plugin`. Used by Task 12.

- [ ] **Step 1: Write the failing test for the trigger matcher**

Create `wiki-article/wiki-suggest.plugin.spec.ts`:

```ts
import {matchTrigger} from './wiki-suggest.plugin';

describe('matchTrigger', () => {
    it('matches a slash at the start of a block', () => {
        expect(matchTrigger('/')).toEqual({trigger: '/', query: '', from: 0});
    });

    it('captures the query typed after a slash', () => {
        expect(matchTrigger('/tab')).toEqual({trigger: '/', query: 'tab', from: 0});
    });

    // Otherwise typing a URL or "and/or" mid-sentence opens the block menu.
    it('ignores a slash that follows other text', () => {
        expect(matchTrigger('and/or')).toBeNull();
    });

    it('closes the slash menu once a space is typed', () => {
        expect(matchTrigger('/tab le')).toBeNull();
    });

    it('matches a double bracket anywhere in a line', () => {
        expect(matchTrigger('see [[')).toEqual({trigger: '[[', query: '', from: 4});
    });

    it('captures the query typed after a double bracket, spaces included', () => {
        // Page titles contain spaces, so unlike the slash menu this query must not stop at one.
        expect(matchTrigger('see [[Getting star')).toEqual({
            trigger: '[[', query: 'Getting star', from: 4,
        });
    });

    it('closes the bracket menu once the link is closed', () => {
        expect(matchTrigger('see [[Setup]]')).toBeNull();
    });

    it('ignores a single bracket', () => {
        expect(matchTrigger('see [Setup')).toBeNull();
    });

    it('matches nothing in plain text', () => {
        expect(matchTrigger('hello world')).toBeNull();
    });

    it('matches nothing in an empty block', () => {
        expect(matchTrigger('')).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/ng test --include=src/app/features/guild/components/wiki/wiki-article/wiki-suggest.plugin.spec.ts --watch=false`
Expected: FAIL — cannot resolve `./wiki-suggest.plugin`.

- [ ] **Step 3: Write the plugin**

Create `wiki-article/wiki-suggest.plugin.ts`:

```ts
import {Plugin, PluginKey} from '@tiptap/pm/state';

/**
 * The two editor triggers: `/` for block insertion, `[[` for a page link.
 *
 * Written directly against @tiptap/pm rather than pulling in @tiptap/suggestion, which is not
 * installed. Doing it here also means the menus render as Angular components instead of detached
 * DOM, so they stay themeable with the rest of the app.
 */

export type SuggestTrigger = '/' | '[[';

export interface SuggestState {
    trigger: SuggestTrigger;
    query: string;
    /** Offset within the block where the trigger starts, so the menu can replace it on select. */
    from: number;
}

export const wikiSuggestKey = new PluginKey('wikiSuggest');

/** A slash only counts at the very start of a block, or "and/or" would open the block menu. */
const SLASH_RE = /^\/([^\s]*)$/;
/** Brackets count anywhere, and the query keeps spaces because page titles have them. */
const BRACKET_RE = /\[\[([^\]]*)$/;

export function matchTrigger(textBefore: string): SuggestState | null {
    const slash = SLASH_RE.exec(textBefore);
    if (slash) return {trigger: '/', query: slash[1], from: 0};

    const bracket = BRACKET_RE.exec(textBefore);
    if (bracket) {
        return {trigger: '[[', query: bracket[1], from: bracket.index};
    }

    return null;
}

export function wikiSuggestPlugin(onChange: (state: SuggestState | null) => void): Plugin {
    return new Plugin({
        key: wikiSuggestKey,
        view: () => ({
            update: view => {
                const {selection} = view.state;
                if (!selection.empty) {
                    onChange(null);
                    return;
                }
                const {$from} = selection;
                const textBefore = $from.parent.textBetween(
                    0,
                    $from.parentOffset,
                    undefined,
                    '￼',
                );
                onChange(matchTrigger(textBefore));
            },
        }),
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/ng test --include=src/app/features/guild/components/wiki/wiki-article/wiki-suggest.plugin.spec.ts --watch=false`
Expected: PASS, 10 tests.

- [ ] **Step 5: Write the bubble menu component**

Create `wiki-article/wiki-bubble-menu.component.ts`:

```ts
import {Component, computed, input, signal} from '@angular/core';
import {Editor} from '@tiptap/core';

interface BubbleAction {
    label: string;
    title: string;
    mark: string;
    attrs?: Record<string, unknown>;
    run: (editor: Editor) => void;
    className?: string;
}

@Component({
    selector: 'app-wiki-bubble-menu',
    template: `
        @if (visible()) {
            <div [style.left.px]="position().left" [style.top.px]="position().top"
                 class="fixed z-50 flex items-center gap-0.5 rounded-lg border border-border
                        bg-card px-1 py-1 shadow-xl -translate-x-1/2 -translate-y-full">
                @for (action of actions; track action.title) {
                    <button (click)="apply(action)"
                            [class.text-brand-dim]="isActive(action)"
                            [class]="action.className"
                            [title]="action.title"
                            class="flex h-7 min-w-7 items-center justify-center rounded-md border-0
                                   bg-transparent px-1.5 text-white/55 hover:bg-hover hover:text-white/90
                                   cursor-pointer transition-colors">
                        {{ action.label }}
                    </button>
                }
            </div>
        }
    `,
})
export class WikiBubbleMenuComponent {
    readonly editor = input<Editor | undefined>(undefined);

    protected readonly visible = signal(false);
    protected readonly position = signal({top: 0, left: 0});

    protected readonly actions: BubbleAction[] = [
        {label: 'B', title: 'Bold', mark: 'bold', className: 'font-bold', run: e => e.chain().focus().toggleBold().run()},
        {label: 'I', title: 'Italic', mark: 'italic', className: 'italic', run: e => e.chain().focus().toggleItalic().run()},
        {label: 'U', title: 'Underline', mark: 'underline', className: 'underline', run: e => e.chain().focus().toggleUnderline().run()},
        {label: 'S', title: 'Strikethrough', mark: 'strike', className: 'line-through', run: e => e.chain().focus().toggleStrike().run()},
        {label: '<>', title: 'Inline code', mark: 'code', className: 'font-mono text-[0.6875rem]', run: e => e.chain().focus().toggleCode().run()},
        {label: 'H1', title: 'Heading 1', mark: 'heading', attrs: {level: 1}, className: 'text-[0.6875rem] font-bold', run: e => e.chain().focus().toggleHeading({level: 1}).run()},
        {label: 'H2', title: 'Heading 2', mark: 'heading', attrs: {level: 2}, className: 'text-[0.6875rem] font-bold', run: e => e.chain().focus().toggleHeading({level: 2}).run()},
        {label: 'H3', title: 'Heading 3', mark: 'heading', attrs: {level: 3}, className: 'text-[0.6875rem] font-bold', run: e => e.chain().focus().toggleHeading({level: 3}).run()},
        {label: '❝', title: 'Quote', mark: 'blockquote', run: e => e.chain().focus().toggleBlockquote().run()},
    ];

    /** Called by the article on every selection change. */
    sync(): void {
        const editor = this.editor();
        if (!editor || !editor.isEditable) {
            this.visible.set(false);
            return;
        }
        const {from, to, empty} = editor.state.selection;
        if (empty || from === to) {
            this.visible.set(false);
            return;
        }
        const start = editor.view.coordsAtPos(from);
        const end = editor.view.coordsAtPos(to);
        this.position.set({
            top: Math.min(start.top, end.top) - 8,
            left: (start.left + end.left) / 2,
        });
        this.visible.set(true);
    }

    protected isActive(action: BubbleAction): boolean {
        return this.editor()?.isActive(action.mark, action.attrs) ?? false;
    }

    protected apply(action: BubbleAction): void {
        const editor = this.editor();
        if (editor) action.run(editor);
    }
}
```

- [ ] **Step 6: Write the slash menu component**

Create `wiki-article/wiki-slash-menu.component.ts`:

```ts
import {Component, computed, input, output, signal} from '@angular/core';
import {Editor} from '@tiptap/core';

export interface SlashItem {
    label: string;
    icon: string;
    keywords: string;
    run: (editor: Editor) => void;
}

@Component({
    selector: 'app-wiki-slash-menu',
    template: `
        @if (open()) {
            <div [style.left.px]="position().left" [style.top.px]="position().top"
                 class="fixed z-50 w-56 overflow-hidden rounded-xl border border-border bg-card
                        py-1 shadow-xl">
                @for (item of filtered(); track item.label; let i = $index) {
                    <button (click)="choose(item)"
                            [class.bg-hover]="i === activeIndex()"
                            class="flex w-full items-center gap-2.5 border-0 bg-transparent px-3 py-2
                                   text-left text-[0.8125rem] text-white/75 hover:bg-hover cursor-pointer">
                        <i [class]="item.icon" class="pi text-[0.75rem] text-white/40"></i>
                        {{ item.label }}
                    </button>
                }
                @if (filtered().length === 0) {
                    <p class="px-3 py-2 text-[0.75rem] text-white/30">No blocks match</p>
                }
            </div>
        }
    `,
})
export class WikiSlashMenuComponent {
    readonly editor = input<Editor | undefined>(undefined);
    readonly query = input('');
    readonly open = input(false);
    readonly position = input<{top: number; left: number}>({top: 0, left: 0});

    readonly selected = output<SlashItem>();

    protected readonly activeIndex = signal(0);

    protected readonly items: SlashItem[] = [
        {label: 'Heading 1', icon: 'pi-hashtag', keywords: 'h1 title heading', run: e => e.chain().focus().toggleHeading({level: 1}).run()},
        {label: 'Heading 2', icon: 'pi-hashtag', keywords: 'h2 heading subtitle', run: e => e.chain().focus().toggleHeading({level: 2}).run()},
        {label: 'Heading 3', icon: 'pi-hashtag', keywords: 'h3 heading', run: e => e.chain().focus().toggleHeading({level: 3}).run()},
        {label: 'Bullet list', icon: 'pi-list', keywords: 'bullet unordered list ul', run: e => e.chain().focus().toggleBulletList().run()},
        {label: 'Numbered list', icon: 'pi-sort-numeric-up-alt', keywords: 'numbered ordered list ol', run: e => e.chain().focus().toggleOrderedList().run()},
        {label: 'Task list', icon: 'pi-check-square', keywords: 'task todo checkbox', run: e => e.chain().focus().toggleTaskList().run()},
        {label: 'Quote', icon: 'pi-comment', keywords: 'quote blockquote', run: e => e.chain().focus().toggleBlockquote().run()},
        {label: 'Code block', icon: 'pi-code', keywords: 'code block pre', run: e => e.chain().focus().toggleCodeBlock().run()},
        {label: 'Divider', icon: 'pi-minus', keywords: 'divider rule hr separator', run: e => e.chain().focus().setHorizontalRule().run()},
        {label: 'Table', icon: 'pi-table', keywords: 'table grid', run: e => e.chain().focus().insertTable({rows: 3, cols: 3, withHeaderRow: true}).run()},
    ];

    protected readonly filtered = computed(() => {
        const q = this.query().toLowerCase();
        if (!q) return this.items;
        return this.items.filter(i => `${i.label} ${i.keywords}`.toLowerCase().includes(q));
    });

    /** Returns true when the key was consumed, so the editor does not also act on it. */
    handleKey(key: string): boolean {
        if (!this.open()) return false;
        const items = this.filtered();
        if (key === 'ArrowDown') {
            this.activeIndex.update(i => (i + 1) % Math.max(1, items.length));
            return true;
        }
        if (key === 'ArrowUp') {
            this.activeIndex.update(i => (i - 1 + items.length) % Math.max(1, items.length));
            return true;
        }
        if (key === 'Enter') {
            const item = items[this.activeIndex()];
            if (item) this.choose(item);
            return true;
        }
        return false;
    }

    reset(): void {
        this.activeIndex.set(0);
    }

    protected choose(item: SlashItem): void {
        this.selected.emit(item);
    }
}
```

- [ ] **Step 7: Wire both menus into the article**

In `wiki-article.component.html`, add before the closing tag:

```html
<app-wiki-bubble-menu #bubbleMenu [editor]="instance"/>
<app-wiki-slash-menu #slashMenu (selected)="applySlashItem($event)"
                     [editor]="instance" [open]="slashOpen()"
                     [position]="suggestPosition()" [query]="suggestQuery()"/>
```

In `wiki-article.component.ts`, add the imports, `@ViewChild` refs for both menus, and:

```ts
protected readonly slashOpen = signal(false);
protected readonly suggestQuery = signal('');
protected readonly suggestPosition = signal({top: 0, left: 0});
private suggest: SuggestState | null = null;

/** Removes the trigger text before running a block command, so "/table" does not survive. */
protected applySlashItem(item: SlashItem): void {
    const editor = this.editor;
    const suggest = this.suggest;
    if (!editor) return;
    if (suggest) {
        const {$from} = editor.state.selection;
        const start = $from.start() + suggest.from;
        editor.chain().focus().deleteRange({from: start, to: $from.pos}).run();
    }
    item.run(editor);
    this.slashOpen.set(false);
}
```

In `ngAfterViewInit`, register the plugin and the selection hook by extending the `Editor` config:

```ts
extensions: [
    ...wikiExtensions('Type / for blocks, [[ to link a page…'),
    Extension.create({
        name: 'wikiSuggest',
        addProseMirrorPlugins: () => [wikiSuggestPlugin(state => this.onSuggest(state))],
    }),
],
onSelectionUpdate: () => this.bubbleMenu?.sync(),
```

and add:

```ts
private onSuggest(state: SuggestState | null): void {
    this.suggest = state;
    if (!state || !this.editing()) {
        this.slashOpen.set(false);
        return;
    }
    const coords = this.editor!.view.coordsAtPos(this.editor!.state.selection.from);
    this.suggestPosition.set({top: coords.bottom + 6, left: coords.left});
    this.suggestQuery.set(state.query);
    if (state.trigger === '/') {
        if (!this.slashOpen()) this.slashMenu?.reset();
        this.slashOpen.set(true);
    }
    // The '[[' trigger is handled in Task 12.
}
```

Add a keydown listener on the editor element that forwards Arrow/Enter/Escape to
`slashMenu.handleKey(...)` and calls `preventDefault()` when it returns true.

- [ ] **Step 8: Verify**

Run: `./node_modules/.bin/ng test --include=src/app/features/guild/components/wiki/wiki-article/wiki-suggest.plugin.spec.ts --watch=false`
Expected: PASS.

Run: `./node_modules/.bin/ng build --configuration development`
Expected: build succeeds.

In the app: select text in edit mode and confirm the bubble menu appears above the selection and
that its buttons highlight for active marks; type `/` on an empty line and confirm the block menu
filters as you type, moves with arrow keys, inserts on Enter, and leaves no `/table` text behind.
Confirm typing `and/or` mid-sentence does **not** open the menu.

- [ ] **Step 9: Commit**

```bash
git add src/app/features/guild/components/wiki/wiki-article/
git commit -m "feat(wiki): selection bubble menu and slash block menu"
```

---

### Task 12: Internal page links

**Files:**
- Create: `src/app/features/guild/components/wiki/wiki-article/wiki-link-menu.component.ts`
- Modify: `src/app/features/guild/components/wiki/wiki-article/wiki-article.component.ts`
- Modify: `src/app/features/guild/components/wiki/wiki-article/wiki-article.component.html`

**Interfaces:**
- Consumes: `wikiHref`, `parseWikiHref` from `wiki-links.ts`; `SuggestState` from `wiki-suggest.plugin.ts`; `searchWiki` from `wiki-search.ts`.
- Produces: `WikiLinkMenuComponent` (selector `app-wiki-link-menu`) with inputs `open: boolean`, `query: string`, `position: {top: number; left: number}`, `pages: WikiPageSummaryDto[]`; output `selected: WikiPageSummaryDto`.

- [ ] **Step 1: Write the picker component**

Create `wiki-article/wiki-link-menu.component.ts`:

```ts
import {Component, computed, input, output, signal} from '@angular/core';
import {WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {searchWiki} from '../wiki-search';

@Component({
    selector: 'app-wiki-link-menu',
    template: `
        @if (open()) {
            <div [style.left.px]="position().left" [style.top.px]="position().top"
                 class="fixed z-50 w-64 overflow-hidden rounded-xl border border-border bg-card
                        py-1 shadow-xl">
                @for (page of matches(); track page.id; let i = $index) {
                    <button (click)="selected.emit(page)"
                            [class.bg-hover]="i === activeIndex()"
                            class="flex w-full items-center gap-2.5 border-0 bg-transparent px-3 py-2
                                   text-left text-[0.8125rem] text-white/75 hover:bg-hover cursor-pointer">
                        <i class="pi pi-file text-[0.75rem] text-white/40"></i>
                        <span class="truncate">{{ page.title }}</span>
                    </button>
                }
                @if (matches().length === 0) {
                    <p class="px-3 py-2 text-[0.75rem] text-white/30">No page matches</p>
                }
            </div>
        }
    `,
})
export class WikiLinkMenuComponent {
    readonly open = input(false);
    readonly query = input('');
    readonly position = input<{top: number; left: number}>({top: 0, left: 0});
    readonly pages = input<readonly WikiPageSummaryDto[]>([]);

    readonly selected = output<WikiPageSummaryDto>();

    protected readonly activeIndex = signal(0);

    /** An empty query lists recent pages, so `[[` is useful before you type anything. */
    protected readonly matches = computed(() => {
        const pages = this.pages();
        const query = this.query();
        if (!query.trim()) return [...pages].slice(0, 8);
        const byId = new Map(pages.map(p => [p.id, p]));
        return searchWiki(
            pages.map(p => ({id: p.id, title: p.title, tags: p.tags})),
            query,
            8,
        ).map(hit => byId.get(hit.id)!).filter(Boolean);
    });

    handleKey(key: string): boolean {
        if (!this.open()) return false;
        const items = this.matches();
        if (key === 'ArrowDown') {
            this.activeIndex.update(i => (i + 1) % Math.max(1, items.length));
            return true;
        }
        if (key === 'ArrowUp') {
            this.activeIndex.update(i => (i - 1 + items.length) % Math.max(1, items.length));
            return true;
        }
        if (key === 'Enter') {
            const page = items[this.activeIndex()];
            if (page) this.selected.emit(page);
            return true;
        }
        return false;
    }

    reset(): void {
        this.activeIndex.set(0);
    }
}
```

- [ ] **Step 2: Insert the link on selection**

In `wiki-article.component.ts`, add `linkMenuOpen = signal(false)`, extend `onSuggest` to open the
link menu for the `'[['` trigger, and add:

```ts
/**
 * Replaces the whole `[[query` run with a link mark carrying a `wiki:` href. An ordinary Link
 * mark, not a custom node - the markdown serializer already round-trips those, so the link
 * survives save and reload with no custom serializer.
 */
protected applyPageLink(page: WikiPageSummaryDto): void {
    const editor = this.editor;
    const suggest = this.suggest;
    if (!editor || !suggest) return;
    const {$from} = editor.state.selection;
    const start = $from.start() + suggest.from;
    editor.chain()
        .focus()
        .deleteRange({from: start, to: $from.pos})
        .insertContent({
            type: 'text',
            text: page.title,
            marks: [{type: 'link', attrs: {href: wikiHref(page.id)}}],
        })
        // Without this the link mark stays active and the next typed character joins the link.
        .unsetMark('link')
        .run();
    this.linkMenuOpen.set(false);
}
```

- [ ] **Step 3: Mark broken links**

Add to `wiki-article.component.ts`, called from `setContent` and `onUpdate`:

```ts
/**
 * Flags links whose target no longer exists. Done as a DOM attribute pass rather than a schema
 * rule because the set of valid ids changes as pages are created and deleted, while the stored
 * content does not.
 */
private markBrokenLinks(): void {
    const known = new Set((this.wiki()?.pages ?? []).map(p => p.id));
    const root = this.editorEl?.nativeElement;
    if (!root) return;
    root.querySelectorAll('a').forEach(anchor => {
        const pageId = parseWikiHref(anchor.getAttribute('href'));
        if (pageId === null) return;
        anchor.setAttribute('data-wiki-broken', String(!known.has(pageId)));
    });
}
```

- [ ] **Step 4: Add the menu to the template**

```html
<app-wiki-link-menu #linkMenu (selected)="applyPageLink($event)"
                    [open]="linkMenuOpen()" [pages]="wiki()?.pages ?? []"
                    [position]="suggestPosition()" [query]="suggestQuery()"/>
```

Forward Arrow/Enter keys to `linkMenu.handleKey(...)` alongside the slash menu in the existing
keydown handler.

- [ ] **Step 5: Verify**

Run: `./node_modules/.bin/ng build --configuration development`
Expected: build succeeds.

In the app: type `[[` in edit mode, confirm the picker lists pages and filters as you type, select
one and confirm the link inserts with the page title as its label. Save, reload the page, and
confirm the link **survives the round trip** — this is the claim the whole link design rests on.
Click it in read mode and confirm it navigates in-app rather than opening a URL. Delete the target
page and confirm the link renders in the offline colour.

- [ ] **Step 6: Commit**

```bash
git add src/app/features/guild/components/wiki/wiki-article/
git commit -m "feat(wiki): [[ page links with in-app navigation and broken-link marking"
```

---

### Task 13: Context rail

**Files:**
- Create: `src/app/features/guild/components/wiki/wiki-rail/wiki-context-rail.component.ts`
- Create: `src/app/features/guild/components/wiki/wiki-rail/wiki-context-rail.component.html`
- Modify: `src/app/features/guild/components/wiki/wiki.component.html`
- Modify: `src/app/features/guild/components/wiki/wiki.component.ts`

**Interfaces:**
- Consumes: `buildToc`, `TocEntry` from `wiki-toc.ts`; `buildBacklinkIndex` from `wiki-links.ts`; `WikiContentCacheService`; `GuildService.getMembers`.
- Produces: `WikiContextRailComponent` (selector `app-wiki-context-rail`) with inputs `page: WikiPageDto | null`, `wiki: WikiDto | null`, `guildId: string`, `headings: Heading[]`, `editing: boolean`; outputs `tocEntrySelected: string`, `openPage: WikiPageSummaryDto`, `propertiesChanged: void`.

- [ ] **Step 1: Write the rail component**

Create `wiki-rail/wiki-context-rail.component.ts` with four computed sections:

```ts
import {Component, computed, effect, inject, input, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Select} from 'primeng/select';
import {Checkbox} from 'primeng/checkbox';
import {WikiDto, WikiPageDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {GuildMemberDto} from '../../../../../dtos/response/member.dto';
import {GuildService} from '../../../../../services/guild.service';
import {AvatarComponent} from '../../../../../components/avatar/avatar.component';
import {WikiContentCacheService} from '../wiki-content-cache.service';
import {buildBacklinkIndex} from '../wiki-links';
import {buildToc, Heading} from '../wiki-toc';

@Component({
    selector: 'app-wiki-context-rail',
    imports: [FormsModule, Select, Checkbox, AvatarComponent],
    templateUrl: './wiki-context-rail.component.html',
    host: {class: 'flex flex-col h-full min-h-0'},
})
export class WikiContextRailComponent {
    readonly page = input<WikiPageDto | null>(null);
    readonly wiki = input<WikiDto | null>(null);
    readonly guildId = input.required<string>();
    readonly headings = input<readonly Heading[]>([]);
    readonly editing = input(false);

    readonly tocEntrySelected = output<string>();
    readonly openPage = output<WikiPageSummaryDto>();

    protected readonly activeHeadingId = signal<string | null>(null);
    protected readonly members = signal<ReadonlyMap<string, GuildMemberDto>>(new Map());

    private readonly cache = inject(WikiContentCacheService);
    private readonly guildService = inject(GuildService);

    /** Below two headings a table of contents is noise, not navigation. */
    protected readonly toc = computed(() => {
        const entries = buildToc(this.headings());
        return entries.length >= 2 ? entries : [];
    });

    protected readonly backlinks = computed(() => {
        const pageId = this.page()?.id;
        if (!pageId) return [];
        const sources = buildBacklinkIndex(this.cache.content()).get(pageId) ?? [];
        const byId = new Map((this.wiki()?.pages ?? []).map(p => [p.id, p]));
        return sources.map(id => byId.get(id)).filter((p): p is WikiPageSummaryDto => !!p);
    });

    /** Backlinks are only trustworthy once every page body has been read. */
    protected readonly backlinksComplete = this.cache.warmed;
    protected readonly backlinksFailed = this.cache.failed;

    protected readonly author = computed(() => {
        const id = this.page()?.authorId;
        return id ? this.members().get(id) ?? null : null;
    });

    protected readonly lastEditor = computed(() => {
        const id = this.page()?.lastEditorId;
        return id ? this.members().get(id) ?? null : null;
    });

    constructor() {
        // Backlinks need every body, so opening the rail is what pays for the warm - not wiki
        // load, for a panel the user may never look at.
        effect(() => {
            const guildId = this.guildId();
            if (guildId) this.cache.warm(guildId);
        });

        effect(() => {
            const guildId = this.guildId();
            if (!guildId) return;
            this.guildService.getMembers(guildId, 0, 200).subscribe({
                next: list => this.members.set(new Map(list.map(m => [m.userId, m]))),
                // Attribution is omitted rather than showing a raw user id.
                error: () => this.members.set(new Map()),
            });
        });
    }

    /** Called by the article's scroll handler with the id of the topmost visible heading. */
    setActiveHeading(id: string | null): void {
        this.activeHeadingId.set(id);
    }
}
```

Adjust `m.userId` to whatever `GuildMemberDto` actually names its user id field — read
`src/app/dtos/response/member.dto.ts` before writing this and use the real name.

- [ ] **Step 2: Write the rail template**

Create `wiki-rail/wiki-context-rail.component.html` with four sections, each hidden when empty:
a `On this page` TOC list whose active entry is styled `text-brand-dim`; a `Properties` block
holding the category select, parent select, tags editor and pinned checkbox moved out of the old
editor meta row; a `Linked from` list rendering `backlinks()` with a `Still indexing…` note while
`!backlinksComplete()`; and an attribution block with `app-avatar` for author and last editor.
Use `thin-scrollbar` on the scrolling container and rem-based text sizes throughout.

- [ ] **Step 3: Mount the rail in the shell**

In `wiki.component.html`, after the article column:

```html
@if (state.wikiView() === 'page' || state.wikiView() === 'editor') {
    <div class="hidden xl:flex w-70 shrink-0 h-full bg-sidebar border-l border-white/[0.10]">
        <app-wiki-context-rail (openPage)="state.openPage($event)"
                               (tocEntrySelected)="scrollToHeading($event)"
                               [editing]="state.wikiView() === 'editor'"
                               [guildId]="guildId()"
                               [headings]="headings()"
                               [page]="state.selectedPage()"
                               [wiki]="state.wiki()"
                               class="flex-1 min-w-0"/>
    </div>
}
```

Add `headings = signal<Heading[]>([])` to `WikiComponent`, bind
`(headingsChanged)="headings.set($event)"` on `app-wiki-article`, and implement `scrollToHeading`
to find the matching heading element by its generated id and `scrollIntoView({behavior: 'smooth'})`.

Note: `w-70` is not a default Tailwind size. Use `w-[17.5rem]` instead, per the rem convention.

- [ ] **Step 4: Verify**

Run: `./node_modules/.bin/ng build --configuration development`
Expected: build succeeds.

In the app on a wide window: confirm the rail appears and that the dead gutter is gone; confirm the
TOC lists headings and clicking one scrolls to it; confirm the properties controls save; confirm
backlinks populate after the warm finishes and show the indexing note before it.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/wiki/
git commit -m "feat(wiki): context rail with TOC, properties, backlinks and attribution"
```

---

### Task 14: Breadcrumb bar

**Files:**
- Create: `src/app/features/guild/components/wiki/wiki-breadcrumbs/wiki-breadcrumbs.component.ts`
- Create: `src/app/features/guild/components/wiki/wiki-breadcrumbs/wiki-breadcrumbs.component.html`
- Test: `src/app/features/guild/components/wiki/wiki-breadcrumbs/wiki-trail.spec.ts`
- Create: `src/app/features/guild/components/wiki/wiki-breadcrumbs/wiki-trail.ts`
- Modify: `src/app/features/guild/components/wiki/wiki.component.html`

**Interfaces:**
- Consumes: `WikiDto`, `WikiPageSummaryDto`.
- Produces: `interface TrailSegment {id: string; label: string; kind: 'category' | 'page'}`, `buildTrail(wiki: WikiDto | null, pageId: string | null): TrailSegment[]`, and `WikiBreadcrumbsComponent` (selector `app-wiki-breadcrumbs`).

- [ ] **Step 1: Write the failing test**

Create `wiki-breadcrumbs/wiki-trail.spec.ts`:

```ts
import {WikiDto} from '../../../../../dtos/response/wiki.dto';
import {buildTrail} from './wiki-trail';

function wiki(over: Partial<WikiDto> = {}): WikiDto {
    return {id: 'w', guildId: 'g', categories: [], pages: [], ...over} as WikiDto;
}

const page = (id: string, title: string, extra: Record<string, unknown> = {}) =>
    ({id, title, guildId: 'g', slug: id, authorId: 'u', createdAt: new Date(), updatedAt: new Date(),
        visibility: 'public', tags: [], isPinned: false, revisionCount: 0, ...extra}) as never;

describe('buildTrail', () => {
    it('returns nothing when no page is selected', () => {
        expect(buildTrail(wiki(), null)).toEqual([]);
    });

    it('returns just the page for a root page with no category', () => {
        const w = wiki({pages: [page('p1', 'Setup')]});
        expect(buildTrail(w, 'p1')).toEqual([{id: 'p1', label: 'Setup', kind: 'page'}]);
    });

    it('puts the category before the page', () => {
        const w = wiki({
            categories: [{id: 'c1', guildId: 'g', name: 'Guides', position: 0}],
            pages: [page('p1', 'Setup', {categoryId: 'c1'})],
        });
        expect(buildTrail(w, 'p1')).toEqual([
            {id: 'c1', label: 'Guides', kind: 'category'},
            {id: 'p1', label: 'Setup', kind: 'page'},
        ]);
    });

    it('walks ancestor pages outermost first', () => {
        const w = wiki({
            pages: [page('root', 'Root'), page('mid', 'Mid', {parentPageId: 'root'}),
                page('leaf', 'Leaf', {parentPageId: 'mid'})],
        });
        expect(buildTrail(w, 'leaf').map(s => s.label)).toEqual(['Root', 'Mid', 'Leaf']);
    });

    // Cyclic parent data exists in the wild - the sidebar already guards against it. An
    // unguarded walk here would hang the render.
    it('terminates on a parent cycle', () => {
        const w = wiki({
            pages: [page('a', 'A', {parentPageId: 'b'}), page('b', 'B', {parentPageId: 'a'})],
        });
        expect(buildTrail(w, 'a').length).toBeLessThanOrEqual(2);
    });

    it('terminates on a page that is its own parent', () => {
        const w = wiki({pages: [page('a', 'A', {parentPageId: 'a'})]});
        expect(buildTrail(w, 'a')).toEqual([{id: 'a', label: 'A', kind: 'page'}]);
    });

    it('returns nothing for an unknown page id', () => {
        expect(buildTrail(wiki({pages: [page('p1', 'Setup')]}), 'nope')).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/ng test --include=src/app/features/guild/components/wiki/wiki-breadcrumbs/wiki-trail.spec.ts --watch=false`
Expected: FAIL — cannot resolve `./wiki-trail`.

- [ ] **Step 3: Write the implementation**

Create `wiki-breadcrumbs/wiki-trail.ts`:

```ts
import {WikiDto} from '../../../../../dtos/response/wiki.dto';

export interface TrailSegment {
    id: string;
    label: string;
    kind: 'category' | 'page';
}

/**
 * Category, then ancestor pages outermost first, then the page itself.
 *
 * The parent walk is cycle-guarded: cyclic parent data exists in practice - `wouldCreateCycle`
 * in the nav exists precisely because of it - and an unguarded walk would spin forever during
 * a render.
 */
export function buildTrail(wiki: WikiDto | null, pageId: string | null): TrailSegment[] {
    if (!wiki || !pageId) return [];
    const byId = new Map(wiki.pages.map(p => [p.id, p]));
    const page = byId.get(pageId);
    if (!page) return [];

    const ancestors: TrailSegment[] = [];
    const visited = new Set<string>([page.id]);
    let current = page.parentPageId ? byId.get(page.parentPageId) : undefined;
    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        ancestors.unshift({id: current.id, label: current.title, kind: 'page'});
        current = current.parentPageId ? byId.get(current.parentPageId) : undefined;
    }

    const category = page.categoryId
        ? wiki.categories.find(c => c.id === page.categoryId)
        : undefined;

    return [
        ...(category ? [{id: category.id, label: category.name, kind: 'category' as const}] : []),
        ...ancestors,
        {id: page.id, label: page.title, kind: 'page' as const},
    ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/ng test --include=src/app/features/guild/components/wiki/wiki-breadcrumbs/wiki-trail.spec.ts --watch=false`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the bar component**

Create the component and template: a `shrink-0` flex row with `px-4 py-2` and a
`border-b border-white/[0.08]`, rendering `buildTrail(...)` segments separated by `pi-angle-right`
icons (page segments clickable, the last one plain), a nav-toggle button on the left below `lg`,
and on the right a save-status pill plus the Edit / History / Delete / overflow actions moved out
of the old page-view header. Emit `openPage`, `edit`, `save`, `cancel`, `history` and `delete`
outputs; wire them in `wiki.component.html` above the article column.

- [ ] **Step 6: Verify**

Run: `./node_modules/.bin/ng build --configuration development`
Expected: build succeeds.

In the app: open a nested page and confirm the trail reads `Category › Parent › Page` and that
clicking an ancestor navigates there.

- [ ] **Step 7: Commit**

```bash
git add src/app/features/guild/components/wiki/
git commit -m "feat(wiki): breadcrumb bar with page actions"
```

---

### Task 15: Search palette

**Files:**
- Create: `src/app/features/guild/components/wiki/wiki-search/wiki-search-palette.component.ts`
- Create: `src/app/features/guild/components/wiki/wiki-search/wiki-search-palette.component.html`
- Modify: `src/app/features/guild/components/wiki/wiki.component.ts`
- Modify: `src/app/features/guild/components/wiki/wiki.component.html`

**Interfaces:**
- Consumes: `searchWiki`, `SearchHit` from `wiki-search.ts`; `WikiContentCacheService`.
- Produces: `WikiSearchPaletteComponent` (selector `app-wiki-search-palette`) with inputs `open: boolean`, `wiki: WikiDto | null`, `guildId: string`; outputs `closed: void`, `pageSelected: WikiPageSummaryDto`.

- [ ] **Step 1: Write the palette**

Key behaviours to implement:

```ts
/** Titles and tags need no requests, so results appear on the first keystroke. */
protected readonly results = computed(() => {
    const pages = this.wiki()?.pages ?? [];
    const content = this.cache.content();
    return searchWiki(
        pages.map(p => ({id: p.id, title: p.title, tags: p.tags, content: content.get(p.id)})),
        this.query(),
    );
});

/** Content coverage is opt-in: one request, taken only when asked for. */
protected searchContents(): void {
    this.cache.warm(this.guildId());
}
```

Template: a fixed full-screen overlay with `bg-black/60`, a centred `max-w-xl` `bg-card` panel with
a search input autofocused on open, the result list showing title, category name and — for content
hits — the snippet. Escape and backdrop click emit `closed`; Arrow keys and Enter drive selection.

The footer states coverage honestly, driven by the cache's three states:

| State | Footer |
|---|---|
| `!warmed() && !warming() && !failed()` | `Search page contents` button — titles and tags only so far |
| `warming()` | `Loading page contents…` |
| `warmed()` | `Searching titles, tags and contents` |
| `failed()` | `Couldn't load page contents — titles and tags only` + Retry |

The `failed` row is the point of the cache's `failed` signal: presenting title-only results under
a full-text banner would misreport what was searched.

- [ ] **Step 2: Wire the shortcut**

In `wiki.component.ts`:

```ts
protected readonly searchOpen = signal(false);

@HostListener('document:keydown', ['$event'])
protected onKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        this.searchOpen.set(true);
    }
}
```

Mount `<app-wiki-search-palette>` in the shell template, and add a search button to the nav header
so the palette is discoverable without knowing the shortcut.

- [ ] **Step 3: Verify**

Run: `./node_modules/.bin/ng build --configuration development`
Expected: build succeeds.

In the app: press ⌘K (Ctrl+K), confirm typing filters pages instantly with no network requests,
confirm Enter opens the highlighted page, confirm `Search page contents` warms the cache and then
surfaces body matches with snippets, and confirm the coverage count is shown rather than results
silently being partial.

- [ ] **Step 4: Commit**

```bash
git add src/app/features/guild/components/wiki/
git commit -m "feat(wiki): command-palette search over titles, tags and contents"
```

---

### Task 16: Draft autosave and save status

**Files:**
- Modify: `src/app/features/guild/components/wiki/wiki-article/wiki-article.component.ts`
- Modify: `src/app/features/guild/components/wiki/wiki-article/wiki-article.component.html`
- Modify: `src/app/features/guild/components/wiki/wiki-breadcrumbs/wiki-breadcrumbs.component.ts`

**Interfaces:**
- Consumes: `WikiDraftsService`, `WikiDraft` from Task 5; `WikiStateService.pendingRemoteUpdate`.
- Produces: `WikiArticleComponent` gains `protected readonly saveStatus: Signal<'idle' | 'draft' | 'saving' | 'saved'>` and `protected restoreDraft(): void`, `protected discardDraft(): void`.

- [ ] **Step 1: Autosave on change**

In `wiki-article.component.ts`, add a debounced write on every editor update and title change:

```ts
private draftTimer?: ReturnType<typeof setTimeout>;

/** Debounced so a burst of typing costs one write, not one per keystroke. */
private scheduleDraft(): void {
    if (!this.editing()) return;
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
        this.drafts.write(this.guildId(), this.page()?.id ?? null, {
            title: this.title(),
            content: this.markdown(),
            tags: [...(this.page()?.tags ?? [])],
            isPinned: this.page()?.isPinned ?? false,
            categoryId: this.page()?.categoryId,
            parentPageId: this.page()?.parentPageId,
            baseUpdatedAt: this.page()?.updatedAt ? String(this.page()!.updatedAt) : null,
            savedAt: Date.now(),
        });
        this.saveStatus.set('draft');
    }, 800);
}
```

Clear the timer in `ngOnDestroy`, and call `this.drafts.clear(...)` in the `save()` success branch.

- [ ] **Step 2: Offer recovery on open**

Add a signal `pendingDraft = signal<WikiDraft | null>(null)`, set in the page effect:

```ts
const existing = this.drafts.read(this.guildId(), page?.id ?? null);
// Suppressed while a remote conflict is showing: two competing "your content is stale"
// banners stacked on top of each other is worse than either alone.
const remoteConflict = this.wikiState.pendingRemoteUpdate()?.id === page?.id;
this.pendingDraft.set(
    existing && !remoteConflict && this.drafts.divergesFrom(existing, page?.title ?? '', page?.content ?? '')
        ? existing
        : null,
);
```

- [ ] **Step 3: Render the recovery bar**

Add above the scroll container in `wiki-article.component.html`:

```html
@if (pendingDraft(); as draft) {
    <div class="flex shrink-0 items-center gap-3 border-b border-brand/20 bg-brand/[0.06] px-6 py-2.5">
        <i class="pi pi-history text-[0.8125rem] text-brand-dim"></i>
        <span class="flex-1 text-[0.8125rem] text-white/70">
            Unsaved changes from {{ draftAge() }}
        </span>
        <button (click)="restoreDraft()"
                class="cursor-pointer rounded border-0 bg-brand/20 px-3 py-1 text-[0.75rem]
                       font-medium text-brand-dim hover:bg-brand/30">Restore</button>
        <button (click)="discardDraft()"
                class="cursor-pointer border-0 bg-transparent px-1 text-[0.75rem] text-white/40
                       hover:text-white/65">Discard</button>
    </div>
}
```

- [ ] **Step 4: Add the save shortcut and status pill**

In the article, handle `⌘S` / `Ctrl+S` to call `save()` and `preventDefault()`. Feed `saveStatus()`
into the breadcrumb bar's pill: `draft` → "Draft saved", `saving` → "Saving…", `saved` → "Saved",
`idle` → nothing.

- [ ] **Step 5: Verify**

Run: `./node_modules/.bin/ng build --configuration development`
Expected: build succeeds.

In the app: edit a page, wait a second, reload the browser without saving, reopen the page, and
confirm the recovery bar offers the draft; Restore brings the text back and Discard removes the bar
permanently. Confirm ⌘S saves and the pill moves through its states. Confirm that a page with a
remote-update conflict shows **only** the conflict banner, not both.

- [ ] **Step 6: Commit**

```bash
git add src/app/features/guild/components/wiki/
git commit -m "feat(wiki): draft autosave with recovery and save-status feedback"
```

---

### Task 17: Revision diff

**Files:**
- Modify: `src/app/features/guild/components/wiki/wiki-history/wiki-history.component.ts`
- Modify: `src/app/features/guild/components/wiki/wiki-history/wiki-history.component.html`

**Interfaces:**
- Consumes: `diffLines`, `diffStat`, `DiffLine` from Task 1.
- Produces: `WikiHistoryComponent` gains `protected readonly compareMode: WritableSignal<'previous' | 'current'>` and `protected diffFor(revision: WikiRevisionDto): DiffLine[]`.

- [ ] **Step 1: Compute the diff**

In `wiki-history.component.ts`:

```ts
protected readonly compareMode = signal<'previous' | 'current'>('previous');

/**
 * Revisions arrive newest first, so a revision's predecessor is the *next* element. Comparing
 * against the wrong neighbour inverts every diff, which reads as plausible and is wrong.
 */
protected diffFor(revision: WikiRevisionDto): DiffLine[] {
    const all = this.revisions();
    const index = all.findIndex(r => r.id === revision.id);
    const before = this.compareMode() === 'current'
        ? revision.content
        : all[index + 1]?.content ?? '';
    const after = this.compareMode() === 'current'
        ? this.page().content
        : revision.content;
    return diffLines(before ?? '', after ?? '');
}

protected statFor(revision: WikiRevisionDto) {
    return diffStat(this.diffFor(revision));
}
```

- [ ] **Step 2: Render the diff**

Replace the expanded `wiki-content` preview in the template with a monospace diff block:

```html
<div class="mt-2 overflow-x-auto rounded-lg border border-white/[0.06] bg-app-bg font-mono text-[0.75rem]">
    @for (line of diffFor(rev); track $index) {
        <div [class]="line.type === 'add' ? 'bg-emerald-500/10 text-emerald-300/90'
                    : line.type === 'del' ? 'bg-rose-500/10 text-rose-300/90'
                    : 'text-white/45'"
             class="whitespace-pre-wrap px-3 py-0.5">
            <span class="mr-2 select-none opacity-40">{{ line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ' }}</span>{{ line.text }}
        </div>
    }
    @if (diffFor(rev).length === 0) {
        <p class="px-3 py-2 text-white/30">No changes in this revision.</p>
    }
</div>
```

Add a `+N −M` stat chip on each revision row from `statFor(rev)`, and a `Compare against:
previous / current` toggle above the list.

- [ ] **Step 3: Confirm restore with a diff**

Replace the bare Restore action with a confirmation dialog that renders `diffFor(revision)` under
"Restoring will make these changes", so Restore is never a blind action.

- [ ] **Step 4: Add the edit-summary field**

The server accepts `summary` on `UpdateWikiPageDto` as of Echo `7ae3a50`, and stores it on the
revision the save creates. In `wiki-article.component.ts`, add:

```ts
protected readonly editSummary = signal('');

/**
 * Only offered when the body actually changed. The server ignores a summary on a
 * metadata-only update because no revision is created to carry it, so showing the field
 * there would invite the user to write a note that is silently dropped.
 */
protected readonly summaryApplies = computed(() =>
    this.markdown() !== (this.page()?.content ?? ''));
```

Pass it in `save()`:

```ts
const base = {
    title: this.title().trim(),
    content: this.markdown(),
    ...(this.summaryApplies() && this.editSummary().trim()
        ? {summary: this.editSummary().trim()}
        : {}),
};
```

Clear `editSummary` on a successful save. Render it as a single-line input in the save affordance
in the breadcrumb bar, shown only when `summaryApplies()`, placeholder `What changed? (optional)`,
Enter submitting the save.

In `wiki-history.component.html`, the existing "No summary" italic fallback stays — it is now
truthful for old revisions rather than universal.

- [ ] **Step 5: Verify**

Run: `./node_modules/.bin/ng build --configuration development`
Expected: build succeeds.

In the app: edit a page several times, open History, and confirm each revision shows only what
changed, that the stat chip matches the visible line counts, that the compare toggle flips the
comparison, and that Restore previews the change before applying it.

Then edit a page with a summary and confirm it appears against that revision in History. Edit only
the title and confirm no summary field is offered, since no revision is created.

- [ ] **Step 6: Commit**

```bash
git add src/app/features/guild/components/wiki/
git commit -m "feat(wiki): revision diffs and edit summaries"
```

---

### Task 18: Permission gating

**Files:**
- Modify: `src/app/features/guild/components/wiki/wiki-state.service.ts`
- Modify: `src/app/features/guild/components/wiki/wiki-breadcrumbs/wiki-breadcrumbs.component.ts`
- Modify: `src/app/features/guild/components/wiki/wiki-nav/wiki-nav.component.ts`
- Modify: `src/app/features/guild/components/wiki/wiki-nav/wiki-nav.component.html`
- Modify: `src/app/features/guild/components/wiki/wiki-history/wiki-history.component.html`

**Interfaces:**
- Consumes: `wikiAbilities`, `canEditPage` from Task 7; `GuildService.getOwnMember`; `effectiveGuildPermissions` from `src/app/features/guild/guild-permissions.ts`.
- Produces: `WikiStateService` gains `readonly abilities: Signal<WikiAbilities>` and `readonly ownUserId: Signal<string | null>`.

- [ ] **Step 1: Load abilities into the state service**

```ts
readonly abilities = signal<WikiAbilities>(wikiAbilities(0n));

// Cleared before each fetch, not after: leaving the previous guild's answer live while the
// new request is in flight would show manage controls to a non-manager for the duration, and
// for the whole session if the request fails. Same guard as the events panel uses.
private loadAbilities(guildId: string): void {
    this.abilities.set(wikiAbilities(0n));
    this.guildService.getOwnMember(guildId).subscribe({
        next: member => this.abilities.set(wikiAbilities(effectiveGuildPermissions(member))),
        error: () => this.abilities.set(wikiAbilities(0n)),
    });
}
```

Call it from `initialize()` whenever the guild id changes.

- [ ] **Step 2: Gate the controls**

- Breadcrumb bar: `@if (canEdit())` around Edit, `@if (abilities().canDelete)` around Delete, where
  `canEdit()` is `canEditPage(state.abilities(), page.authorId, state.ownUserId())`.
- Nav: `@if (state.abilities().canCreate)` around the `+` new-page button and the context-menu
  "New Page Here" items; `@if (state.abilities().canManageStructure)` around Add Category, the
  category delete buttons, and `[draggable]` on tree rows.
- History: `@if (state.abilities().canManageRevisions)` around Restore.

- [ ] **Step 3: Verify**

Run: `./node_modules/.bin/ng build --configuration development`
Expected: build succeeds.

In the app, with a member holding no wiki permissions: confirm no Edit, Delete, New Page, Add
Category or Restore controls appear, and that tree rows are not draggable. Confirm the controls do
**not** flash visible during load — they must start hidden and only appear once permissions arrive.

- [ ] **Step 4: Commit**

```bash
git add src/app/features/guild/components/wiki/
git commit -m "feat(wiki): gate wiki controls on the wiki permission bits"
```

---

### Task 19: Translate the wiki

Two commits: the code change referencing keys, then the locale submodule bump. Splitting them is
required — the locales are a separate git repository.

**Files:**
- Modify: every template under `src/app/features/guild/components/wiki/`
- Modify: `src/assets/i18n/locales/en.json` (and sibling locales) — **submodule**

- [ ] **Step 1: Replace hardcoded strings with keys**

Move every user-facing string to `| translate` with a `WIKI.` key. Group them:
`WIKI.NAV.*` (Home, Pinned, Pages, Add Category, No pages yet), `WIKI.ARTICLE.*` (Untitled,
placeholder, Edit, Delete, History, Save, Cancel), `WIKI.RAIL.*` (On this page, Properties,
Category, Parent, Tags, Pinned, Linked from, Still indexing, Created by, Last edited by),
`WIKI.SEARCH.*` (placeholder, No results, Search page contents, Searched N of M),
`WIKI.HISTORY.*` (Revision history, Current, Restore, No changes, Compare against),
`WIKI.DRAFT.*` (Unsaved changes, Restore, Discard), `WIKI.DIALOG.*` (delete confirmations).

`wiki-editor.component.ts` and `wiki-sidebar.component.ts` already import `TranslateModule` without
using it; every file that now uses the pipe must actually import it.

- [ ] **Step 2: Verify no English remains**

Run: `./node_modules/.bin/ng build --configuration development`
Expected: build succeeds.

In the app with a non-English locale selected, confirm no untranslated English is visible in the
wiki. Missing keys render as the raw key, which makes gaps obvious.

- [ ] **Step 3: Commit the code**

```bash
git add src/app/features/guild/components/wiki/
git commit -m "feat(wiki): route wiki strings through i18n"
```

- [ ] **Step 4: Add the strings to the locale submodule**

```bash
cd src/assets/i18n/locales
# add every WIKI.* key to en.json and each sibling locale
git add .
git commit -m "feat(i18n): wiki redesign strings"
cd ../../../..
git add src/assets/i18n/locales
git commit -m "chore(i18n): bump locales for wiki strings"
```

---

## Post-implementation

- [ ] Run the full suite: `./node_modules/.bin/ng test --watch=false`
- [ ] Delete the now-unused `wiki-editor/` and `wiki-page-view/` directories if nothing imports them, and confirm with `git grep -n "wiki-editor\|wiki-page-view"` returning nothing outside history.
- [ ] Confirm `git grep -n "wikiPanelGuildId"` returns nothing.
- [ ] Update `docs/superpowers/specs/2026-08-05-wiki-redesign-design.md` if any decision changed during implementation.
