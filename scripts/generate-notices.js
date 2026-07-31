#!/usr/bin/env node
/**
 * Generates `src/assets/THIRD-PARTY-NOTICES.md` from the full transitive dependency tree.
 *
 * Run with `bun run licenses`. The output is committed; CI regenerates it and fails on a diff, so
 * adding a dependency without recording its licence breaks the build rather than shipping silently.
 *
 * Two properties matter more than anything else here:
 *
 *  - **Nothing is invented.** Licence text is either copied verbatim from the file the package
 *    ships, or taken from `spdx-texts.js` - where the long licences are themselves harvested from
 *    a package in this very tree rather than typed from memory.
 *  - **Nothing is skipped quietly.** A package whose terms cannot be resolved aborts the run and is
 *    named. A notices file with silent holes is worse than none, because it looks like diligence.
 *
 * The output contains no timestamp. A generation date would make the CI staleness check fail on
 * every run regardless of whether the dependency tree actually changed.
 */

const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const {INLINE_TEXTS, HARVEST_MARKERS, PREFERENCE} = require('./spdx-texts');

const REPO = path.resolve(__dirname, '..');
const SRC_TAURI = path.join(REPO, 'src-tauri');
const OUT_FILE = path.join(REPO, 'src', 'assets', 'THIRD-PARTY-NOTICES.md');
const EXTRA_FILE = path.join(__dirname, 'extra-notices.md');

/**
 * `.spdx` files are SPDX metadata documents, not licence text - the Tauri plugin packages ship one
 * instead of a licence. Treating them as text would put a machine-readable manifest in front of the
 * reader where the terms should be, so they are excluded and those packages fall back to SPDX text.
 */
const LICENSE_FILE_RE = /^(LICEN[CS]E|COPYING|NOTICE|UNLICENSE)/i;
const NOT_LICENSE_TEXT_RE = /\.(spdx|json|ya?ml)$/i;

/**
 * Notice files that live in this repository rather than in a package directory, and so are
 * invisible to both collectors.
 *
 * These are embedded verbatim instead of being restated in `extra-notices.md`, so that editing the
 * source notice is enough - there is no second copy to drift out of sync with the first.
 *
 * The bundled WebRTC C++ is the important one: it sits a directory below the vendored crate, so the
 * crate's own `COPYING` (which the Rust collector does find) is not the notice for the code that
 * actually gets compiled into the binary.
 */
const REPO_NOTICE_FILES = [
    {
        file: 'src-tauri/assets/hrir/NOTICE.md',
        title: 'SADIE II HRIR sphere — bundled audio data',
        markdown: true,
    },
    {
        file: 'src-tauri/vendor/webrtc-audio-processing-sys/webrtc-audio-processing/COPYING',
        title: 'WebRTC audio processing (bundled C++) — licence',
    },
    {
        file: 'src-tauri/vendor/webrtc-audio-processing-sys/webrtc-audio-processing/AUTHORS',
        title: 'WebRTC audio processing (bundled C++) — authors',
    },
];

// ── SPDX expression handling ─────────────────────────────────────────────────

/** Legacy manifests write `MIT/Apache-2.0`; SPDX means `OR` by that. */
function normalizeExpression(expr) {
    return String(expr).replace(/\s*\/\s*/g, ' OR ').replace(/\s+/g, ' ').trim();
}

/** Splits on `op` at paren depth zero, so `(MIT OR Apache-2.0) AND IJG` splits correctly on AND. */
function splitTopLevel(expr, op) {
    const parts = [];
    const token = ` ${op} `;
    let depth = 0;
    let start = 0;
    for (let i = 0; i < expr.length; i++) {
        const c = expr[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (depth === 0 && expr.slice(i, i + token.length).toUpperCase() === token) {
            parts.push(expr.slice(start, i));
            i += token.length - 1;
            start = i + 1;
        }
    }
    parts.push(expr.slice(start));
    return parts.map(p => p.trim()).filter(Boolean);
}

function stripOuterParens(s) {
    let out = s.trim();
    while (out.startsWith('(') && out.endsWith(')')) out = out.slice(1, -1).trim();
    return out;
}

/**
 * Parses an expression into conjuncts of alternatives.
 *
 * `AND` is a conjunction of obligations - every side must be satisfied, so every side is emitted.
 * `jpeg-encoder` is the case that makes this matter: `(MIT OR Apache-2.0) AND IJG` means the IJG
 * credit is owed no matter which permissive licence is chosen for the other half.
 */
function parseExpression(expr) {
    return splitTopLevel(normalizeExpression(expr), 'AND')
        .map(conj => splitTopLevel(stripOuterParens(conj), 'OR').map(stripOuterParens));
}

/** `Apache-2.0 WITH LLVM-exception` resolves against the base licence's text. */
function baseId(token) {
    return token.split(/\s+WITH\s+/i)[0].trim();
}

function chooseAlternative(alternatives) {
    let best = null;
    let bestRank = Infinity;
    for (const alt of alternatives) {
        const rank = PREFERENCE.indexOf(baseId(alt));
        if (rank !== -1 && rank < bestRank) {
            bestRank = rank;
            best = alt;
        }
    }
    return best || alternatives[0];
}

/** The licence ids actually relied on, one per conjunct. */
function resolveExpression(expr) {
    return parseExpression(expr).map(chooseAlternative);
}

// ── Reading packages off disk ────────────────────────────────────────────────

function readLicenseFiles(dir) {
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    return names
        .filter(n => LICENSE_FILE_RE.test(n) && !NOT_LICENSE_TEXT_RE.test(n))
        .sort()
        .map(name => {
            const full = path.join(dir, name);
            try {
                if (!fs.statSync(full).isFile()) return null;
                const text = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n').trim();
                return text ? {name, text} : null;
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

/**
 * Builds the pool of long licence texts by finding a package in the tree that ships each one.
 * Copying an Apache-2.0 already sitting on disk is verifiable; reproducing 11kB of it from memory
 * is not.
 */
function harvestTexts(entries) {
    const pool = {};
    for (const entry of entries) {
        for (const file of entry.files) {
            for (const [id, marker] of Object.entries(HARVEST_MARKERS)) {
                if (!pool[id] && marker.test(file.text)) {
                    pool[id] = {text: file.text, from: `${entry.name} ${entry.version}`};
                }
            }
        }
    }
    return pool;
}

/**
 * Comparison form for licence bodies: letters and digits only.
 *
 * Packages wrap the same licence at different column widths and vary the punctuation around the
 * copyright line, so a literal comparison finds almost no duplicates. Reducing to alphanumerics
 * makes the body match regardless of layout while still being specific enough that two different
 * licences cannot collide.
 */
function comparisonForm(text) {
    const map = [];
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (/[a-z0-9]/i.test(c)) {
            out += c.toLowerCase();
            map.push(i);
        }
    }
    return {text: out, map};
}

/**
 * Detects that a shipped licence file is a known body preceded by a copyright notice, and returns
 * that notice.
 *
 * This is what keeps the output a readable document rather than a megabyte of repetition: some 900
 * packages ship the same MIT text differing only in one line, and that line is the only part the
 * licence actually requires be preserved per-package. The body is then printed once, at the end.
 *
 * Returns null when the file is not simply `<notice><known body>` — a modified or unrecognised
 * licence is always reproduced verbatim rather than being forced into a match.
 */
/**
 * Apache-2.0's appendix is instructions for applying the licence, not terms of it. Packages ship it
 * with the placeholders filled in, so two copies of the same licence differ in the middle and never
 * compare equal. It is excised before matching and reproduced once in the shared body.
 */
const APACHE_APPENDIX_RE =
    /APPENDIX:\s*How to apply the Apache License[\s\S]*?limitations under the License\.?/i;

/** Placeholder lines from an unfilled appendix are not anybody's copyright notice. */
const PLACEHOLDER_RE = /\[yyyy]|\[name of copyright owner]|\[fullname]|<year>|<name of author>/i;

/**
 * How much unrecognised text may remain around a matched licence body before the file is treated as
 * carrying terms of its own. Set low deliberately: the whole point is that nothing substantive gets
 * dropped, and a file with real extra terms - an LLVM exception, a dual-licence preamble - must be
 * reproduced in full rather than silently reduced to a reference.
 */
const MAX_UNRECOGNISED_CHARS = 600;

/**
 * Detects that a shipped licence file is a known body wrapped in package-specific copyright lines,
 * and returns those lines.
 *
 * This is what keeps the output a readable document rather than a megabyte of repetition: some 900
 * packages ship the same handful of licences, differing only in who holds the copyright, and that
 * holder is the part the licence actually requires be preserved per package. The body is printed
 * once, at the end, and linked to.
 *
 * Returns null whenever anything is left over that we cannot account for, so an unusual or modified
 * licence is always reproduced verbatim rather than forced into a match.
 */
function matchCanonicalBody(fileText, canonicalText) {
    const canon = comparisonForm(canonicalText.replace(APACHE_APPENDIX_RE, '').trim());
    if (!canon.text || canon.text.length < 200) return null;

    const file = comparisonForm(fileText);
    const at = file.text.indexOf(canon.text);
    if (at === -1) return null;

    const before = fileText.slice(0, file.map[at]);
    const after = fileText.slice(file.map[at + canon.text.length - 1] + 1);
    const remainder = `${before}\n${after}`.replace(APACHE_APPENDIX_RE, '\n');

    // Everything not part of the recognised body is kept, not just the lines that look like a
    // copyright notice. A dual-licence preamble or an added clause is exactly the text that must
    // not go missing, and it does not always announce itself in a form worth pattern-matching for.
    const kept = [];
    for (const line of remainder.split('\n').map(l => l.trim())) {
        // The body match ends at its last alphanumeric character, so trailing punctuation and rule
        // lines survive into the remainder. Neither carries a notice.
        if (!line || !/[a-z0-9]/i.test(line) || PLACEHOLDER_RE.test(line)) continue;
        if (!kept.includes(line)) kept.push(line);
    }
    const header = kept.join('\n');

    // Past this much unrecognised text the file is not "a notice in front of a known body" at all,
    // so reproducing it whole is more faithful than reducing it to a reference plus a preamble.
    if (comparisonForm(header).text.length > MAX_UNRECOGNISED_CHARS) return null;

    return {header};
}

function attributionLine(entry) {
    const who = entry.authors && entry.authors.length
        ? entry.authors.join(', ')
        : entry.repository || entry.name;
    return `Copyright (c) the ${entry.name} authors — ${who}`;
}

// ── Rust ─────────────────────────────────────────────────────────────────────

function cargoMetadata(cwd) {
    const args = ['metadata', '--format-version', '1'];
    const opts = {cwd, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']};
    try {
        return JSON.parse(execFileSync('cargo', args, opts));
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            return JSON.parse(execFileSync('cargo', args, {...opts, shell: true}));
        }
        throw err;
    }
}

/**
 * Every crate reachable from the root, excluding dev-only edges.
 *
 * Build edges are kept on purpose. A `-sys` crate reached through a build dependency links real
 * code into the shipped binary, so dropping build edges would under-attribute. The cost is a few
 * genuinely build-only crates such as `tauri-build` appearing in the list. Over-attributing is
 * harmless; under-attributing is the failure that matters.
 */
function rustClosure(meta) {
    const nodes = new Map(meta.resolve.nodes.map(n => [n.id, n]));
    const packages = new Map(meta.packages.map(p => [p.id, p]));
    const rootId = meta.resolve.root;

    const seen = new Set();
    const queue = [rootId];
    while (queue.length) {
        const id = queue.shift();
        if (seen.has(id)) continue;
        seen.add(id);
        const node = nodes.get(id);
        if (!node) continue;
        for (const dep of node.deps) {
            const kinds = dep.dep_kinds || [];
            const devOnly = kinds.length > 0 && kinds.every(k => k.kind === 'dev');
            if (!devOnly) queue.push(dep.pkg);
        }
    }
    seen.delete(rootId);

    return [...seen]
        .map(id => packages.get(id))
        .filter(Boolean)
        .map(p => {
            const dir = path.dirname(p.manifest_path);
            return {
                ecosystem: 'rust',
                name: p.name,
                version: p.version,
                license: p.license || (p.license_file ? 'see licence file' : ''),
                repository: p.repository || '',
                authors: (p.authors || []).filter(Boolean),
                dir,
                files: readLicenseFiles(dir),
            };
        });
}

// ── npm ──────────────────────────────────────────────────────────────────────

const norm = p => path.resolve(p).replace(/\\/g, '/');

/**
 * Node's own resolution: nearest `node_modules` first, then upward. Paths are normalised to forward
 * slashes throughout, because mixing separators makes the upward walk's containment check fail on
 * Windows and silently truncate the tree to its first level.
 */
function resolvePackageDir(name, fromDir, rootDir) {
    const root = norm(rootDir);
    let dir = norm(fromDir);
    for (;;) {
        const candidate = norm(path.join(dir, 'node_modules', name));
        if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
        if (dir === root) return null;
        const up = norm(path.dirname(dir));
        if (up === dir || !up.startsWith(root)) return null;
        dir = up;
    }
}

function readManifest(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

function declaredLicense(manifest) {
    let license = manifest.license;
    if (!license && Array.isArray(manifest.licenses)) {
        license = manifest.licenses.map(l => (typeof l === 'string' ? l : l.type)).filter(Boolean).join(' OR ');
    }
    if (license && typeof license === 'object') license = license.type || '';
    return license || '';
}

function manifestAuthors(manifest) {
    const one = a => (typeof a === 'string' ? a : a && a.name ? a.name : null);
    return [one(manifest.author), ...(manifest.contributors || []).map(one)].filter(Boolean);
}

function repositoryUrl(manifest) {
    const r = manifest.repository;
    if (!r) return manifest.homepage || '';
    return (typeof r === 'string' ? r : r.url || '') || manifest.homepage || '';
}

/**
 * The production closure. `devDependencies` are excluded at the root because they never reach a
 * user; a dependency's own devDependencies are not installed at all, so they need no handling.
 *
 * Optional dependencies are followed but tolerated when absent: the platform-specific native
 * binaries (rollup, lightningcss, the Tailwind oxide builds) only install on their own platform,
 * so a run on Windows cannot see the macOS ones. They are reported rather than ignored.
 */
function npmClosure(rootDir) {
    const rootManifest = readManifest(rootDir);
    const seen = new Map();
    const optional = new Map();
    const unresolved = new Set();
    const queue = Object.keys(rootManifest.dependencies || {}).map(name => ({name, from: rootDir}));

    while (queue.length) {
        const {name, from} = queue.shift();
        const dir = resolvePackageDir(name, from, rootDir);
        if (!dir) {
            // A non-optional dependency that will not resolve means the tree is incomplete and the
            // output would be missing real packages. That is a failure, not a footnote.
            unresolved.add(name);
            continue;
        }
        if (seen.has(dir)) continue;

        let manifest;
        try {
            manifest = readManifest(dir);
        } catch {
            unresolved.add(name);
            continue;
        }
        seen.set(dir, {
            ecosystem: 'npm',
            name: manifest.name || name,
            version: manifest.version || '',
            license: declaredLicense(manifest),
            repository: repositoryUrl(manifest),
            authors: manifestAuthors(manifest),
            dir,
            files: readLicenseFiles(dir),
        });

        for (const dep of Object.keys(manifest.dependencies || {})) queue.push({name: dep, from: dir});

        // Optional dependencies are recorded but never walked into. They are the per-platform native
        // builds - rollup, lightningcss, the Tailwind oxide binaries - and only the current
        // platform's copy is ever on disk. Reading whichever happens to be installed would make this
        // file differ between a Windows and a Linux run, and the CI staleness check would then fail
        // for reasons that have nothing to do with the dependency tree changing.
        for (const dep of Object.keys(manifest.optionalDependencies || {})) {
            if (!optional.has(dep)) optional.set(dep, manifest.name || name);
        }
    }

    // An optional package that is also reachable as a regular dependency is covered in full above.
    const listedNames = new Set([...seen.values()].map(p => p.name));
    for (const name of [...optional.keys()]) if (listedNames.has(name)) optional.delete(name);

    return {
        packages: [...seen.values()],
        optional: [...optional.entries()].sort((a, b) => a[0].localeCompare(b[0])),
        unresolved: [...unresolved].sort(),
    };
}

// ── Rendering ────────────────────────────────────────────────────────────────

const byNameThenVersion = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);

/**
 * Resolves the notice text for one package, or explains why it cannot be.
 *
 * A shipped file always wins - it carries the real copyright holder, which a generic SPDX body
 * cannot. Only when a package ships nothing do we fall back, and then the holder is reconstructed
 * from the manifest so the attribution survives.
 */
function noticeFor(entry, pool, catalogue) {
    if (entry.files.length) {
        const refs = [];
        const blocks = [];
        for (const file of entry.files) {
            const hit = catalogue
                .map(c => ({id: c.id, match: matchCanonicalBody(file.text, c.text)}))
                .find(r => r.match);
            if (hit) refs.push({id: hit.id, header: hit.match.header});
            else blocks.push({label: file.name, text: file.text});
        }
        return {refs, blocks};
    }

    if (!entry.license) {
        return {error: 'declares no licence and ships no licence file'};
    }

    const refs = [];
    for (const token of resolveExpression(entry.license)) {
        const id = baseId(token);
        if (!INLINE_TEXTS[id] && !pool[id]) return {error: `no text available for licence "${id}"`};
        refs.push({id, header: attributionLine(entry)});
    }
    return {refs, blocks: []};
}

/**
 * Known licence bodies, longest first so that a longer body wins over any shorter one contained
 * within it (0BSD's terms are a strict subset of ISC's, and would otherwise swallow it).
 */
function canonicalCatalogue(pool) {
    const list = [
        ...Object.entries(INLINE_TEXTS).map(([id, text]) => ({id, text})),
        ...Object.entries(pool).map(([id, v]) => ({id, text: v.text})),
    ];
    return list.sort((a, b) => b.text.length - a.text.length);
}

/**
 * Groups packages that carry exactly the same notice - the same copyright line against the same
 * licence body - so a shared notice is printed once rather than per package.
 */
function groupByNotice(entries, pool, catalogue) {
    const groups = new Map();
    const failures = [];
    const usedLicenceIds = new Set();

    for (const entry of entries.slice().sort(byNameThenVersion)) {
        const notice = noticeFor(entry, pool, catalogue);
        if (notice.error) {
            failures.push(`${entry.name} ${entry.version} (${entry.ecosystem}): ${notice.error}`);
            continue;
        }
        for (const ref of notice.refs) usedLicenceIds.add(ref.id);

        const key = JSON.stringify([
            notice.refs.map(r => [r.id, r.header]),
            notice.blocks.map(b => b.text),
        ]);
        if (!groups.has(key)) groups.set(key, {refs: notice.refs, blocks: notice.blocks, packages: []});
        groups.get(key).packages.push(entry);
    }

    const ordered = [...groups.values()].sort((a, b) => byNameThenVersion(a.packages[0], b.packages[0]));
    return {groups: ordered, failures, usedLicenceIds};
}

const anchorFor = id => `licence-${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

/**
 * Emits a fenced block whose fence is longer than any backtick run inside it, per CommonMark.
 *
 * Some packages ship their licence as markdown containing its own fenced block. A fixed three-tick
 * fence lets that inner fence close the outer one, and everything after it renders as prose - which
 * silently corrupts every notice that follows.
 */
function fencedBlock(text) {
    let longest = 0;
    for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return [`${fence}text`, text, fence];
}

function renderGroup(group) {
    const lines = [];
    lines.push(`### ${group.packages.map(p => `${p.name} ${p.version}`).join(', ')}`);
    lines.push('');

    const licences = [...new Set(group.packages.map(p => p.license).filter(Boolean))];
    if (licences.length) lines.push(`**Licence:** ${licences.join(' / ')}`);
    const repos = [...new Set(group.packages.map(p => p.repository).filter(Boolean))];
    if (repos.length) lines.push(`**Source:** ${repos[0]}`);
    lines.push('');

    for (const ref of group.refs) {
        if (ref.header) {
            lines.push(...fencedBlock(ref.header));
        }
        lines.push(`Distributed under the [${ref.id} licence](#${anchorFor(ref.id)}), reproduced in full below.`);
        lines.push('');
    }

    // Anything that did not match a known body is reproduced exactly as the package ships it.
    for (const block of group.blocks) {
        lines.push(`<!-- ${block.label} -->`);
        lines.push(...fencedBlock(block.text));
        lines.push('');
    }
    return lines.join('\n');
}

function renderSection(title, intro, groups) {
    const packageCount = groups.reduce((n, g) => n + g.packages.length, 0);
    return [
        `## ${title}`,
        '',
        `${intro} ${packageCount} packages, ${groups.length} distinct notices.`,
        '',
        ...groups.map(renderGroup),
    ].join('\n');
}

/**
 * The licence bodies themselves, printed once each at the end of the document and linked to from
 * every package that relies on them.
 */
function renderLicenceTexts(usedIds, pool) {
    const lines = [
        '## Licence texts',
        '',
        'The full text of each licence referenced above.',
        '',
    ];
    for (const id of [...usedIds].sort()) {
        const text = INLINE_TEXTS[id] || (pool[id] && pool[id].text);
        if (!text) continue;
        lines.push(`<a id="${anchorFor(id)}"></a>`);
        lines.push('');
        lines.push(`### ${id}`);
        lines.push('');
        if (!INLINE_TEXTS[id]) lines.push(`_Text as shipped by ${pool[id].from}._`, '');
        lines.push(...fencedBlock(text), '');
    }
    return lines.join('\n');
}

/**
 * Demotes markdown headings by two levels, outside fenced blocks, so an embedded document nests
 * under its own `###` heading instead of restarting the outline at `#`.
 */
function demoteHeadings(markdown) {
    let inFence = false;
    return markdown.split('\n').map(line => {
        if (/^\s*```/.test(line)) inFence = !inFence;
        if (inFence) return line;
        return line.replace(/^(#{1,4})\s/, (_, hashes) => `##${hashes} `);
    }).join('\n');
}

/** Embeds the in-repo notice files listed in REPO_NOTICE_FILES, failing loudly if one has moved. */
function renderRepoNotices(repoDir) {
    const sections = ['## Bundled data and vendored source', '',
        'Components compiled or embedded into the application that are not package-manager dependencies,',
        'and so appear in neither list below.', ''];

    for (const notice of REPO_NOTICE_FILES) {
        const full = path.join(repoDir, notice.file);
        const text = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n').trim();
        sections.push(`### ${notice.title}`, '');
        sections.push(`_Source: \`${notice.file}\`_`, '');
        if (notice.markdown) {
            sections.push(demoteHeadings(text), '');
        } else {
            sections.push(...fencedBlock(text), '');
        }
    }
    return sections.join('\n');
}

function render({rustGroups, npmGroups, optional, extra, repoNotices, licenceTexts}) {
    const head = [
        '# Third-party notices',
        '',
        'This application incorporates third-party software. The copyright notices and licence terms',
        'below are reproduced as those licences require.',
        '',
        '_Generated by `scripts/generate-notices.js`. Do not edit by hand — run `bun run licenses`._',
        '',
    ].join('\n');

    const parts = [head, extra.trim(), '', repoNotices, ''];
    parts.push(renderSection(
        'Rust crates',
        'Compiled into the application binary.',
        rustGroups,
    ));
    parts.push(renderSection(
        'npm packages',
        'Bundled into the application frontend.',
        npmGroups,
    ));

    if (optional.length) {
        parts.push([
            '## Platform-specific native builds',
            '',
            'Optional packages containing a prebuilt binary for one platform each; a given install has',
            'only the one it runs on. Each is published by the project named beside it and carries that',
            "project's licence, reproduced in full above.",
            '',
            ...optional.map(([name, parent]) => `- \`${name}\` — part of ${parent}`),
            '',
        ].join('\n'));
    }

    parts.push(licenceTexts);

    return parts.join('\n') + '\n';
}

// ── Entry point ──────────────────────────────────────────────────────────────

function main() {
    process.stdout.write('Collecting Rust crates…\n');
    const rust = rustClosure(cargoMetadata(SRC_TAURI));

    process.stdout.write('Collecting npm packages…\n');
    const {packages: npm, optional, unresolved} = npmClosure(REPO);

    if (unresolved.length) {
        process.stderr.write('\nThese dependencies could not be resolved in node_modules:\n');
        for (const name of unresolved) process.stderr.write(`  - ${name}\n`);
        process.stderr.write('\nRun `bun install` and try again.\n');
        process.exit(1);
    }

    const pool = harvestTexts([...rust, ...npm]);
    const missingPool = Object.keys(HARVEST_MARKERS).filter(id => !pool[id]);
    const catalogue = canonicalCatalogue(pool);

    const rustResult = groupByNotice(rust, pool, catalogue);
    const npmResult = groupByNotice(npm, pool, catalogue);
    const failures = [...rustResult.failures, ...npmResult.failures];
    const usedLicenceIds = new Set([...rustResult.usedLicenceIds, ...npmResult.usedLicenceIds]);

    if (failures.length) {
        process.stderr.write('\nCannot resolve licence terms for:\n');
        for (const f of failures) process.stderr.write(`  - ${f}\n`);
        process.stderr.write(
            '\nAdd the licence id to scripts/spdx-texts.js, or record the package in ' +
            'scripts/extra-notices.md if its terms cannot be expressed as SPDX.\n');
        process.exit(1);
    }

    if (!fs.existsSync(EXTRA_FILE)) {
        process.stderr.write(`Missing ${EXTRA_FILE}\n`);
        process.exit(1);
    }
    const extra = fs.readFileSync(EXTRA_FILE, 'utf8').replace(/\r\n/g, '\n');

    const output = render({
        rustGroups: rustResult.groups,
        npmGroups: npmResult.groups,
        optional,
        extra,
        repoNotices: renderRepoNotices(REPO),
        licenceTexts: renderLicenceTexts(usedLicenceIds, pool),
    });

    fs.mkdirSync(path.dirname(OUT_FILE), {recursive: true});
    fs.writeFileSync(OUT_FILE, output, 'utf8');

    const kb = Math.round(Buffer.byteLength(output, 'utf8') / 1024);
    process.stdout.write(
        `\nWrote ${path.relative(REPO, OUT_FILE)} — ${rust.length} crates, ${npm.length} npm packages, ${kb} kB\n`);
    if (missingPool.length) {
        process.stdout.write(`Unused SPDX harvest markers (nothing in the tree needed them): ${missingPool.join(', ')}\n`);
    }
    if (optional.length) {
        process.stdout.write(`${optional.length} platform-specific native builds listed by name.\n`);
    }
}

if (require.main === module) main();

module.exports = {
    normalizeExpression,
    splitTopLevel,
    parseExpression,
    chooseAlternative,
    resolveExpression,
    baseId,
    rustClosure,
    npmClosure,
    resolvePackageDir,
    declaredLicense,
    noticeFor,
    groupByNotice,
    harvestTexts,
    demoteHeadings,
    fencedBlock,
    matchCanonicalBody,
    canonicalCatalogue,
    REPO_NOTICE_FILES,
};
