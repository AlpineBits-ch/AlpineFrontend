import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
    classifyMlsStorageFault,
    MLS_AEAD_FAILURE_ERROR,
    MLS_BLOB_TOO_SHORT_ERROR,
    MLS_GROUP_DATA_MISSING_ERROR,
    MLS_GROUP_LOAD_FAILED_ERROR,
    MLS_NO_STATE_KEY_ERROR,
    MLS_NOT_A_STATE_BLOB_ERROR,
    MLS_SEALED_NO_STATE_KEY_ERROR,
    MLS_STATE_DID_NOT_OPEN_ERROR,
    MLS_STATE_KEY_UNAVAILABLE_MARKERS,
    MLS_STATE_UNREADABLE_MARKERS,
    MlsStorageInitSteps,
    runMlsStorageInit,
} from './mls-storage-init';

/** The TypeScript half of a cross-language contract. */

// ---------------------------------------------------------------------------
// Reading the Rust sources
// ---------------------------------------------------------------------------

/** The engine crate's source directory, found by walking up to the directory holding `angular.json`. */
function cryptoSrcDir(): string {
    let dir = specDir();

    for (let i = 0; i < 12; i++) {
        const src = path.join(dir, 'crates', 'venta-crypto', 'src');
        if (fs.existsSync(path.join(dir, 'angular.json')) && fs.existsSync(src)) return src;

        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    throw new Error(`Could not locate crates/venta-crypto/src by walking up from ${specDir()}`);
}

function specDir(): string {
    // `new URL(...).pathname` is `/C:/Users/...` on Windows; the drive letter has to come first for
    // `path` to treat it as absolute, or every `existsSync` above quietly answers false.
    const pathname = decodeURIComponent(new URL(import.meta.url).pathname);
    return path.dirname(pathname.replace(/^\/([A-Za-z]:)/, '$1'));
}

/** One Rust source, with string literals rendered as the strings they produce. */
function rustSource(file: string): string {
    return fs.readFileSync(path.join(cryptoSrcDir(), file), 'utf8').replace(/\\\r?\n\s*/g, '');
}

/** Every string this classifier's decisions rest on, with where it has to still appear. */
const CONTRACT: readonly {literal: string; label: string; files: readonly string[]}[] = [
    {
        literal: MLS_NO_STATE_KEY_ERROR,
        label: 'the no-state-key refusal (transient: nothing was read, nothing may be wiped)',
        // Both, and it is the deliberate agreement between them that this classifier relies on.
        files: ['mls.rs', 'wasm.rs'],
    },
    {
        literal: MLS_SEALED_NO_STATE_KEY_ERROR,
        label: 'the sealed-file-without-a-key refusal (transient)',
        files: ['mls.rs'],
    },
    {
        literal: MLS_STATE_DID_NOT_OPEN_ERROR,
        label: 'the undecryptable-state-file error (corrupt: may wipe)',
        files: ['mls.rs'],
    },
    {
        literal: MLS_GROUP_DATA_MISSING_ERROR,
        label: 'the group-listed-but-missing error (corrupt: may wipe)',
        files: ['mls.rs'],
    },
    {
        literal: MLS_GROUP_LOAD_FAILED_ERROR,
        label: 'the group-load-failed error (corrupt: may wipe)',
        files: ['mls.rs'],
    },
    {
        literal: MLS_BLOB_TOO_SHORT_ERROR,
        label: 'the blob-too-short error (corrupt: may wipe)',
        files: ['mls.rs'],
    },
];

describe('the engine error strings this classifier matches on', () => {
    it.each(CONTRACT)('$label is still in $files', ({literal, files}) => {
        for (const file of files) {
            expect(
                rustSource(file),
                `crates/venta-crypto/src/${file} no longer contains:\n  ${literal}\n\n` +
                    `That string is a cross-language contract. MainPageComponent classifies an ` +
                    `initStorage failure by matching on it, and only the "state is present and ` +
                    `unreadable" class is allowed to wipe this device's MLS state. If the engine ` +
                    `message was reworded deliberately, update mls-storage-init.ts *and* re-check the ` +
                    `marker lists - a reworded message that stops matching falls through to "unknown", ` +
                    `which does not wipe (safe) but leaves genuinely corrupt state unrepaired.`,
            ).toContain(literal);
        }
    });

    it('is worded identically on the native and wasm sides of mls_init_storage', () => {
        // wasm.rs copies the refusal from init_storage_from_parts rather than paraphrasing it, and
        // says so. If that ever drifts, one host's transient fault becomes the other host's wipe.
        expect(rustSource('wasm.rs')).toContain(MLS_NO_STATE_KEY_ERROR);
        expect(rustSource('mls.rs')).toContain(MLS_NO_STATE_KEY_ERROR);
    });

    it('reads the Rust sources at all, so a broken path cannot pass as a clean sweep', () => {
        // Without this, a wrong directory or a failed continuation-unfolding would make every
        // `toContain` above assert against an empty string - and an empty haystack fails loudly, but
        // a *stale* one would not. This pins the two facts that make the search meaningful.
        expect(rustSource('mls.rs')).toContain('pub(crate) fn init_storage_from_parts');
        expect(rustSource('wasm.rs')).toContain('pub fn mls_init_storage');
    });

    it('keeps every marker a substring of the message it stands for', () => {
        // The classifier matches shortened invariants, not whole sentences, so that re-syncing the
        // wording with venta-mobile does not break it. That is only sound while each marker is
        // genuinely part of the message it is derived from.
        expect(MLS_NO_STATE_KEY_ERROR).toContain(MLS_STATE_KEY_UNAVAILABLE_MARKERS[0]);
        expect(MLS_SEALED_NO_STATE_KEY_ERROR).toContain(MLS_STATE_KEY_UNAVAILABLE_MARKERS[0]);

        for (const message of [
            MLS_STATE_DID_NOT_OPEN_ERROR,
            MLS_GROUP_DATA_MISSING_ERROR,
            MLS_GROUP_LOAD_FAILED_ERROR,
            MLS_BLOB_TOO_SHORT_ERROR,
            MLS_AEAD_FAILURE_ERROR,
            MLS_NOT_A_STATE_BLOB_ERROR,
        ]) {
            expect(
                MLS_STATE_UNREADABLE_MARKERS.some(m => message.includes(m)),
                `no corrupt-state marker matches: ${message}`,
            ).toBe(true);
        }
    });
});

describe('classifyMlsStorageFault', () => {
    it('never wipes for a missing state key, whichever host raised it', () => {
        for (const message of [MLS_NO_STATE_KEY_ERROR, MLS_SEALED_NO_STATE_KEY_ERROR]) {
            const fault = classifyMlsStorageFault(message);

            expect(fault.kind).toBe('state-key-unavailable');
            // The assertion the whole file is for. A wipe here destroys the only copy of this
            // device's group keys in response to a keychain that was not answering yet.
            expect(fault.mayWipe).toBe(false);
            expect(fault.retryable).toBe(true);
        }
    });

    it("classifies the wasm adapter's pass-through of that refusal the same way", () => {
        // `mls-engine.web.spec.ts` asserts this exact wording survives `WebMlsEngine.call`. This is
        // the other end of that assertion: it arrives here and it must not wipe.
        const fault = classifyMlsStorageFault(
            'MlsError: no state key was supplied - mls_state.json cannot be written unsealed, so ' +
                'encryption stays unavailable until the keychain produces one',
        );

        expect(fault.mayWipe).toBe(false);
    });

    it.each([
        [`${MLS_STATE_DID_NOT_OPEN_ERROR}: aead::Error`, 'a sealed file that did not authenticate'],
        [
            'MlsError: group AAAA is listed in state but its data is missing from storage - state may be corrupted',
            'a group whose data is gone',
        ],
        ['MlsError: failed to load group AAAA from storage: bad record', 'openmls refusing a record'],
        [MLS_BLOB_TOO_SHORT_ERROR, 'a truncated blob'],
        [MLS_AEAD_FAILURE_ERROR, 'the web import path failing to authenticate'],
        [
            '"alpine-mls-state"/"state" key "state::device-a" does not hold a state blob',
            'something else written under the blob key',
        ],
    ])('treats %s as corrupt state, which may wipe (%s)', message => {
        const fault = classifyMlsStorageFault(message);

        expect(fault.kind).toBe('state-unreadable');
        expect(fault.mayWipe).toBe(true);
        expect(fault.retryable).toBe(false);
    });

    it.each([
        // The most likely transient failure of all, and it matches none of the engine's wording:
        // `MlsService.initStorage` reads the state key out of SecureStore *before* calling the
        // engine, so a keychain fault rejects with the OS message and nothing else.
        ['The Windows Credential Manager is not available (os error 1223)', 'a keychain hiccup'],
        ['Failed to open the IndexedDB database "alpine-secure-store"', 'an IndexedDB fault on web'],
        ['Access is denied. (os error 5)', 'std::fs::read failing on the state file'],
        ['MLS is unavailable: this build has no local MLS engine.', 'the wasm module failing to load'],
        ['expected value at line 1 column 1', 'a bare serde error from a legacy plaintext file'],
        ['Command mls_init_storage not found', 'a host with no such command'],
    ])('treats %s as unknown and does not wipe (%s)', message => {
        const fault = classifyMlsStorageFault(message);

        expect(fault.kind).toBe('unknown');
        // Deliberate: wiping is irreversible and not wiping is not, so the unrecognised case takes
        // the recoverable side. See the file comment on mls-storage-init.ts.
        expect(fault.mayWipe).toBe(false);
        expect(fault.retryable).toBe(true);
    });

    it("does not wipe for the web adapter's unreadable-blob refusal", () => {
        // `MlsStateUnreadableError` is latched rather than thrown today, so this is defence in depth:
        // it means "this browser could not read the blob", which is the case where overwriting is
        // least recoverable, and it must never read as corruption.
        const fault = classifyMlsStorageFault(
            new Error(
                'This browser holds saved MLS state but could not read it, so no group operation will be ' +
                    "attempted - writing over it would destroy the only copy of this device's group keys. " +
                    'Reload the page. (the connection is closing)',
            ),
        );

        expect(fault.mayWipe).toBe(false);
    });

    it('reads the message out of every shape a rejection arrives in', () => {
        // Tauri rejects with the bare string, the wasm adapter throws the JsValue string, its own
        // failures are Errors, and MlsTypedError is a plain object.
        expect(classifyMlsStorageFault(MLS_NO_STATE_KEY_ERROR).kind).toBe('state-key-unavailable');
        expect(classifyMlsStorageFault(new Error(MLS_NO_STATE_KEY_ERROR)).kind).toBe('state-key-unavailable');
        expect(classifyMlsStorageFault({kind: 'MlsError', message: MLS_NO_STATE_KEY_ERROR}).kind).toBe(
            'state-key-unavailable',
        );
        expect(classifyMlsStorageFault(null).kind).toBe('unknown');
        expect(classifyMlsStorageFault(undefined).mayWipe).toBe(false);
    });
});

describe('runMlsStorageInit', () => {
    function steps(overrides: Partial<MlsStorageInitSteps> = {}) {
        const calls: string[] = [];
        const base: MlsStorageInitSteps = {
            initStorage: async () => {
                calls.push('initStorage');
                return true;
            },
            wipe: async () => {
                calls.push('wipe');
            },
        };
        return {calls, steps: {...base, ...overrides}};
    }

    it('reports the restore and wipes nothing on a healthy launch', async () => {
        const {calls, steps: s} = steps();

        expect(await runMlsStorageInit(s)).toEqual({restored: true, wiped: false, fault: null});
        expect(calls).toEqual(['initStorage']);
    });

    it('does not wipe when the state key was unavailable', async () => {
        const {calls, steps: s} = steps({
            initStorage: async () => {
                throw MLS_NO_STATE_KEY_ERROR;
            },
        });

        const outcome = await runMlsStorageInit(s);

        // The bug, stated as a test: this launch used to delete the state file, and with it every
        // message in every group this device belongs to, because the keychain had not answered yet.
        expect(calls).not.toContain('wipe');
        expect(outcome.wiped).toBe(false);
        expect(outcome.fault?.kind).toBe('state-key-unavailable');
    });

    it('does not wipe for an unrecognised failure either', async () => {
        const {calls, steps: s} = steps({
            initStorage: async () => {
                throw new Error('the credential service is not running');
            },
        });

        const outcome = await runMlsStorageInit(s);

        expect(calls).not.toContain('wipe');
        expect(outcome.fault?.kind).toBe('unknown');
    });

    it('wipes when the stored state is present and unreadable', async () => {
        const {calls, steps: s} = steps({
            initStorage: async () => {
                throw `${MLS_STATE_DID_NOT_OPEN_ERROR}: aead::Error`;
            },
        });

        const outcome = await runMlsStorageInit(s);

        // The corrupt path still has to work: without it a device with a broken state file can never
        // start fresh, and every launch fails the same way forever. Only `wipe` is recorded because
        // the override above replaced the stub that records `initStorage`.
        expect(calls).toEqual(['wipe']);
        expect(outcome.wiped).toBe(true);
        expect(outcome.fault?.kind).toBe('state-unreadable');
    });
});
