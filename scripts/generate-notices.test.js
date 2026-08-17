/**
 * Tests for the notices generator. Run with `bun run licenses:test`.
 *
 * Plain `node --test` rather than vitest: the Angular test target compiles `src/**` under
 * tsconfig.spec.json, and pulling a CommonJS script in `scripts/` into that build buys nothing.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
    parseExpression,
    resolveExpression,
    chooseAlternative,
    baseId,
    normalizeExpression,
    matchCanonicalBody,
    demoteHeadings,
    fencedBlock,
    npmClosure,
    rustClosure,
    dedupeByNameAndVersion,
    resolvePackageDir,
    declaredLicense,
    noticeFor,
} = require('./generate-notices');

const {INLINE_TEXTS} = require('./spdx-texts');

const REPO = path.resolve(__dirname, '..');

// ── SPDX expressions ─────────────────────────────────────────────────────────

test('legacy slash form is read as OR', () => {
    assert.strictEqual(normalizeExpression('MIT/Apache-2.0'), 'MIT OR Apache-2.0');
    assert.deepStrictEqual(resolveExpression('MIT/Apache-2.0'), ['MIT']);
});

test('AND keeps every conjunct, because both obligations are owed', () => {
    // jpeg-encoder. Dropping the IJG side would lose a credit the licence requires.
    assert.deepStrictEqual(parseExpression('(MIT OR Apache-2.0) AND IJG'), [['MIT', 'Apache-2.0'], ['IJG']]);
    assert.deepStrictEqual(resolveExpression('(MIT OR Apache-2.0) AND IJG'), ['MIT', 'IJG']);
});

test('a wholly parenthesised expression still splits on AND', () => {
    // @bufbuild/protobuf declares `(Apache-2.0 AND BSD-3-Clause)`. Splitting before stripping the
    // outer parens left the AND at depth 1, so the whole string was taken for one licence id.
    assert.deepStrictEqual(parseExpression('(Apache-2.0 AND BSD-3-Clause)'), [
        ['Apache-2.0'],
        ['BSD-3-Clause'],
    ]);
    assert.deepStrictEqual(resolveExpression('(Apache-2.0 AND BSD-3-Clause)'), [
        'Apache-2.0',
        'BSD-3-Clause',
    ]);
});

test('adjacent paren groups are not mistaken for one enclosing pair', () => {
    // `(...)` at both ends without being a single pair: stripping them blindly would splice the
    // two groups into one malformed alternative.
    assert.deepStrictEqual(parseExpression('(MIT OR Apache-2.0) AND (BSD-3-Clause OR ISC)'), [
        ['MIT', 'Apache-2.0'],
        ['BSD-3-Clause', 'ISC'],
    ]);
    assert.deepStrictEqual(resolveExpression('(MIT OR Apache-2.0) AND (BSD-3-Clause OR ISC)'), [
        'MIT',
        'ISC',
    ]);
    assert.deepStrictEqual(resolveExpression('(Zlib) OR (MIT)'), ['MIT']);
});

test('OR picks the cheapest obligation to satisfy', () => {
    assert.deepStrictEqual(resolveExpression('Apache-2.0 OR MIT'), ['MIT']);
    assert.deepStrictEqual(resolveExpression('Zlib OR Apache-2.0 OR MIT'), ['MIT']);
    assert.deepStrictEqual(resolveExpression('MIT OR Apache-2.0 OR LGPL-2.1-or-later'), ['MIT']);
});

test('an unrecognised sole licence is kept rather than dropped', () => {
    assert.deepStrictEqual(resolveExpression('SomeVendorLicense-1.0'), ['SomeVendorLicense-1.0']);
    assert.strictEqual(chooseAlternative(['Weird-1.0']), 'Weird-1.0');
});

test('WITH exceptions resolve against the base licence', () => {
    assert.strictEqual(baseId('Apache-2.0 WITH LLVM-exception'), 'Apache-2.0');
    assert.deepStrictEqual(resolveExpression('Apache-2.0 WITH LLVM-exception'), [
        'Apache-2.0 WITH LLVM-exception',
    ]);
});

// ── Canonical body matching ──────────────────────────────────────────────────

test('a copyright line in front of a known body is preserved, and only that', () => {
    const file = `Copyright (c) 2019 Some Person\n\n${INLINE_TEXTS.MIT}`;
    const match = matchCanonicalBody(file, INLINE_TEXTS.MIT);
    assert.ok(match, 'expected the MIT body to be recognised');
    assert.strictEqual(match.header, 'Copyright (c) 2019 Some Person');
});

test('reflowed text still matches, since packages wrap licences differently', () => {
    const reflowed = `Copyright (c) 2020 Someone\n\n${INLINE_TEXTS.MIT.replace(/\n/g, ' ')}`;
    assert.ok(matchCanonicalBody(reflowed, INLINE_TEXTS.MIT));
});

test('an added clause is never dropped — it is kept or the file falls back to verbatim', () => {
    const clause =
        'ADDITIONAL TERM: you must also send the author a postcard from wherever you ' +
        'deploy this, and may not use it in any product whose name begins with the letter Q.';
    const file = `Copyright (c) 2019 Some Person\n\n${INLINE_TEXTS.MIT}\n\n${clause}`;

    const match = matchCanonicalBody(file, INLINE_TEXTS.MIT);
    if (match) {
        assert.ok(match.header.includes(clause), 'the added clause must survive into the notice');
    }
    // A null result is equally acceptable: the caller then reproduces the whole file verbatim.
});

test('a wall of extra terms falls back to verbatim rather than to a reference', () => {
    const wall = Array.from(
        {length: 12},
        (_, i) =>
            `${i + 1}. A further condition of some length that the licensee is required to observe in full.`,
    ).join('\n');
    const file = `Copyright (c) 2019 Some Person\n\n${INLINE_TEXTS.MIT}\n\n${wall}`;
    assert.strictEqual(matchCanonicalBody(file, INLINE_TEXTS.MIT), null);
});

test('a different licence does not match', () => {
    assert.strictEqual(matchCanonicalBody(INLINE_TEXTS.Zlib, INLINE_TEXTS.MIT), null);
});

test('unfilled appendix placeholders are not treated as a copyright notice', () => {
    const file = `Copyright [yyyy] [name of copyright owner]\n\n${INLINE_TEXTS.MIT}`;
    const match = matchCanonicalBody(file, INLINE_TEXTS.MIT);
    assert.ok(match);
    assert.strictEqual(match.header, '');
});

// ── Markdown emission ────────────────────────────────────────────────────────

test('fences outgrow any backtick run inside the content', () => {
    const [open, , close] = fencedBlock('a\n```\nb');
    assert.strictEqual(open, '````text');
    assert.strictEqual(close, '````');
    assert.strictEqual(fencedBlock('plain')[0], '```text');
});

test('headings demote outside fenced blocks but not inside them', () => {
    const input = ['# Title', '```', '# not a heading', '```', '## Sub'].join('\n');
    assert.strictEqual(
        demoteHeadings(input),
        ['### Title', '```', '# not a heading', '```', '#### Sub'].join('\n'),
    );
});

// ── Rust collection ──────────────────────────────────────────────────────────

test('workspace members are not third parties, but what they pull in still is', () => {
    const pkg = name => ({
        id: name,
        name,
        version: '1.0.0',
        license: 'MIT',
        manifest_path: `/${name}/Cargo.toml`,
    });
    const edge = pkg => ({pkg, dep_kinds: [{kind: null}]});
    const closure = rustClosure({
        workspace_members: ['app', 'own-crate'],
        packages: [pkg('app'), pkg('own-crate'), pkg('vendored')],
        resolve: {
            root: 'app',
            nodes: [
                {id: 'app', deps: [edge('own-crate')]},
                {id: 'own-crate', deps: [edge('vendored')]},
                {id: 'vendored', deps: []},
            ],
        },
    });
    assert.deepStrictEqual(
        closure.map(p => p.name),
        ['vendored'],
    );
});

// ── npm collection ───────────────────────────────────────────────────────────

test('resolution walks up to an ancestor node_modules like Node does', () => {
    const nested = path.join(REPO, 'node_modules', '@angular', 'core');
    assert.ok(resolvePackageDir('rxjs', nested, REPO), 'rxjs should resolve from a nested package');
    assert.strictEqual(resolvePackageDir('definitely-not-a-real-package', nested, REPO), null);
});

test('the production closure excludes devDependencies but keeps runtime deps', () => {
    const {packages} = npmClosure(REPO);
    const names = new Set(packages.map(p => p.name));

    assert.ok(names.has('rxjs'), 'a runtime dependency should be present');
    assert.ok(names.has('marked'), 'a runtime dependency should be present');
    // typescript and vitest are devDependencies, and never reach a user.
    assert.ok(!names.has('typescript'), 'typescript is a devDependency and must not be listed');
    assert.ok(!names.has('vitest'), 'vitest is a devDependency and must not be listed');
});

test('a package installed in several places is listed once', () => {
    // npm trees hoist, so the same name@version routinely lands in more than one directory. The walk
    // is keyed by directory because it has to be - the same name resolves to different versions at
    // different depths - but the output must not be, or it depends on tree layout rather than on the
    // dependency set. It did: `@tauri-apps/api 2.10.1` appeared four times in one heading, and a
    // fresh install and an incremental one produced different files from identical manifests, so the
    // CI staleness check failed for people who had changed nothing.
    const {packages} = npmClosure(REPO);
    const counts = new Map();
    for (const p of packages) {
        const key = `${p.name}@${p.version}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const repeated = [...counts].filter(([, n]) => n > 1);
    assert.deepStrictEqual(repeated, [], 'these were listed more than once');
});

test('distinct versions of one package are still listed separately', () => {
    // The dedupe keys on name *and* version. Collapsing on name alone would drop a licence that
    // genuinely changed between versions.
    const packages = dedupeByNameAndVersion([
        {name: 'universalify', version: '0.1.2', dir: '/a'},
        {name: 'universalify', version: '0.1.2', dir: '/b/node_modules/universalify'},
        {name: 'universalify', version: '0.2.0', dir: '/c'},
    ]);
    assert.deepStrictEqual(
        packages.map(p => `${p.name}@${p.version}`),
        ['universalify@0.1.2', 'universalify@0.2.0'],
    );
    assert.strictEqual(packages[0].dir, '/a', 'the first copy found wins');
});

test('licence declarations are read from every shape npm allows', () => {
    assert.strictEqual(declaredLicense({license: 'MIT'}), 'MIT');
    assert.strictEqual(declaredLicense({license: {type: 'MIT'}}), 'MIT');
    assert.strictEqual(declaredLicense({licenses: [{type: 'MIT'}, {type: 'CC-BY-4.0'}]}), 'MIT OR CC-BY-4.0');
    assert.strictEqual(declaredLicense({}), '');
});

// ── Failure behaviour ────────────────────────────────────────────────────────

test('a package with no licence and no file is an error, not an omission', () => {
    const entry = {name: 'mystery', version: '1.0.0', license: '', authors: [], repository: '', files: []};
    assert.match(noticeFor(entry, {}, []).error, /no licence/);
});

test('a licence with no available text is an error, not an omission', () => {
    const entry = {
        name: 'mystery',
        version: '1.0.0',
        license: 'Nonexistent-9.9',
        authors: [],
        repository: '',
        files: [],
    };
    assert.match(noticeFor(entry, {}, []).error, /no text available/);
});
