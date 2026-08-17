/**
 * The desktop keychain adapter, and the one place its contract is written down as executable fact.
 *
 * <p>Mocking `@tauri-apps/api/core` and `tauri-plugin-secure-storage-api` is legitimate <i>here</i> in
 * a way it is not in the services that used to do it (`mls.service.spec.ts` says so at its head): this
 * file is the adapter, the IPC boundary is the layer below it, and there is nothing further down to
 * fake.</p>
 *
 * <p><b>What these tests are for.</b> `SecureStore` promises that a read which <i>failed</i> rejects
 * rather than answering "no entry" - because `MlsService.localStateKey` mints a fresh state key on an
 * absent answer, and minting over an entry that is still there destroys every group key and every
 * message on the device. This adapter <b>now keeps that promise</b>. It used not to, because
 * `tauri-plugin-secure-storage`'s desktop `get_item` collapses every `keyring` error into
 * `data: None`; the fix is the local `keychain_read` command in `src-tauri/src/keychain.rs`, and reads
 * go through it instead. The tests below pin the resulting contract in both directions - a failure
 * must not resolve, and a genuine absence must not reject - plus the reason the plugin is still
 * imported at all.</p>
 *
 * <p><b>And the assumption underneath all of it.</b> `keychain_read` keeps that promise only while it
 * addresses the same credential the plugin writes; if it does not, `keyring` reports `NoEntry` for an
 * entry that exists and the honest read hands `localStateKey` exactly the lie it was built to refuse -
 * this time on every existing install at once. That derivation has never been read back at runtime, so
 * an absence is cross-checked against the plugin before it is believed, and a disagreement rejects
 * rather than resolving either way. The "absence cross-check" block below is that net.</p>
 */

// vi.hoisted, because vi.mock is lifted above the imports and its factory therefore runs before any
// plain const in this file has been initialised.
const {invoke, setItem, removeItem, pluginGetItem} = vi.hoisted(() => ({
    invoke: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    pluginGetItem: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: (command: string, args?: unknown) => invoke(command, args),
}));

vi.mock('tauri-plugin-secure-storage-api', () => ({
    secureStorage: {
        // Present so the test that asserts it is never called has something to assert against. If the
        // adapter ever regresses to reading through the plugin, that test names the regression rather
        // than the suite failing on an undefined property somewhere downstream.
        getItem: (key: string) => pluginGetItem(key),
        setItem: (key: string, value: string) => setItem(key, value),
        removeItem: (key: string) => removeItem(key),
    },
}));

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    classifyMlsStorageFault,
    MLS_STATE_KEY_UNAVAILABLE_MARKERS,
    MLS_STATE_UNREADABLE_MARKERS,
} from '../../features/main-page/mls-storage-init';
import {createSecureStore} from '../secure-store-factory';
import {KEYCHAIN_ABSENCE_UNCONFIRMED, KEYCHAIN_ADDRESS_MISMATCH, TauriSecureStore} from './secure-store';

/** The command's "present" answer. */
function present(data: string): unknown {
    return {absent: false, data};
}

/** The command's "absent" answer - the only one that licenses a `null`. */
function absent(): unknown {
    return {absent: true, data: null};
}

/**
 * `src-tauri/capabilities`, found by walking up to the directory holding `angular.json`.
 *
 * <p>Not `process.cwd()` and not a counted number of `..`: a runner may change the former, and the
 * test builder bundles specs so `import.meta.url` need not sit at the source path. Same helper shape
 * as `platform-boundary.spec.ts` and `mls-storage-init.spec.ts`, which had to solve this first - a
 * check that silently located no files would pass while asserting nothing.</p>
 */
function capabilitiesDir(): string {
    // `new URL(...).pathname` is `/C:/Users/...` on Windows; the drive letter has to come first for
    // `path` to treat it as absolute, or every `existsSync` below quietly answers false.
    const pathname = decodeURIComponent(new URL(import.meta.url).pathname);
    let dir = path.dirname(pathname.replace(/^\/([A-Za-z]:)/, '$1'));

    for (let i = 0; i < 12; i++) {
        const capabilities = path.join(dir, 'src-tauri', 'capabilities');
        if (fs.existsSync(path.join(dir, 'angular.json')) && fs.existsSync(capabilities)) {
            return capabilities;
        }

        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    throw new Error(`Could not locate src-tauri/capabilities by walking up from ${pathname}`);
}

/**
 * The `permissions` list of one capability file.
 *
 * <p>`secure-storage:default` is the plugin's own set - `allow-set-item`, `allow-get-item`,
 * `allow-remove-item` (`tauri-plugin-secure-storage-1.5.0/permissions/default.toml`) - so either it or
 * the explicit `allow-get-item` permits the read this adapter cross-checks through.</p>
 */
function permissionsIn(file: string): string[] {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const permissions = (parsed as {permissions?: unknown} | null)?.permissions;
    return Array.isArray(permissions) ? permissions.filter((p): p is string => typeof p === 'string') : [];
}

function setup(): TauriSecureStore {
    invoke.mockReset();
    setItem.mockReset();
    removeItem.mockReset();
    pluginGetItem.mockReset();
    setItem.mockResolvedValue(undefined);
    removeItem.mockResolvedValue(undefined);
    // The plugin's own answer for an entry it cannot see, stated rather than left as an unconfigured
    // mock's `undefined`: the default here is "the two readers agree there is nothing there".
    pluginGetItem.mockResolvedValue(null);
    return new TauriSecureStore();
}

/** The rejection `getItem` produced, or a failure if it resolved. */
async function rejectionFrom(store: TauriSecureStore, key: string): Promise<unknown> {
    return store.getItem(key).then(
        value => {
            throw new Error(`expected a rejection, got ${JSON.stringify(value)}`);
        },
        (cause: unknown) => cause,
    );
}

describe('TauriSecureStore', () => {
    it('reports itself hardware backed, which is the flag the key-backup warning is driven by', () => {
        expect(setup().hardwareBacked).toBe(true);
    });

    /**
     * The key name is the whole address of the entry. A prefix, a case change or a rename here does not
     * present as a storage bug - it presents as this device being ejected from every MLS group it
     * belongs to, on a machine that still physically holds the key.
     *
     * <p><b>Reads and writes must address the same entry</b>, and since they now travel by different
     * routes that is asserted rather than assumed: the same string reaches `keychain_read` and the
     * plugin's `setItem`/`removeItem`, unprefixed and unaltered. The `'tauri-storage_'` prefix and the
     * `productName` service that turn it into a platform credential are applied in
     * `src-tauri/src/keychain.rs` for the read and in the plugin for the writes, and `keychain.rs`'s
     * own tests pin that derivation literally against the plugin's.</p>
     */
    it('addresses the same entry from the read command and the write plugin, verbatim', async () => {
        const store = setup();
        invoke.mockResolvedValue(present('c3RvcmVkLWtleQ=='));

        expect(await store.getItem('alpine_mls_device-7_statekey')).toBe('c3RvcmVkLWtleQ==');
        await store.setItem('alpine_mls_device-7_statekey', 'bmV3');
        await store.removeItem('alpine_mls_device-7_statekey');

        expect(invoke).toHaveBeenCalledWith('keychain_read', {key: 'alpine_mls_device-7_statekey'});
        expect(setItem).toHaveBeenCalledWith('alpine_mls_device-7_statekey', 'bmV3');
        expect(removeItem).toHaveBeenCalledWith('alpine_mls_device-7_statekey');
    });

    /**
     * <b>The absent direction, and it matters as much as the failing one.</b> If a genuine "no entry"
     * ever started rejecting, no device could complete first-run setup - `localStateKey` would never
     * mint, so the engine would never get a state key and the app would never launch on a fresh
     * install. That is the opposite catastrophe to the one this adapter was changed to prevent, and
     * just as total, which is why it is pinned rather than left implied.
     */
    it('answers null for a positively absent entry, so a fresh device can still mint', async () => {
        const store = setup();
        invoke.mockResolvedValue(absent());

        expect(await store.getItem('alpine_mls_device-7_statekey')).toBeNull();
    });

    /**
     * <b>The defect this file used to pin, now pinned as fixed.</b> `keyring` distinguishes `NoEntry`
     * from `NoStorageAccess` ("it might be that the credential store is locked"), `BadEncoding`,
     * `Ambiguous` and `PlatformFailure`; the plugin mapped `Err(_) => data: None` and threw all of it
     * away. `keychain_read` maps only `NoEntry` to absence and rejects the rest, so a locked keychain
     * arrives here as a rejection and `localStateKey` propagates it to a retry banner instead of
     * minting over a key that is still there.
     */
    it('rejects when the keychain could not be read, rather than answering "no entry"', async () => {
        const store = setup();
        const failure = new Error(
            'could not read keychain entry "tauri-storage_alpine_mls_device-7_statekey": '
            + 'keyring::Error::NoStorageAccess: Couldn\'t access platform secure storage: '
            + 'Windows ERROR_NO_SUCH_LOGON_SESSION',
        );
        invoke.mockRejectedValue(failure);

        await expect(store.getItem('alpine_mls_device-7_statekey')).rejects.toBe(failure);
    });

    /**
     * No value ever comes from the plugin, and this is the test that documents why.
     *
     * <p>The plugin's `getItem` cannot distinguish absence from failure - one line of `desktop.rs`,
     * `Err(_) => Ok(GetItemResponse { data: None })` - so sourcing a read from it would silently
     * restore the key-loss path regardless of how careful everything above it was. A reviewer moving
     * this back for symmetry with the writes should read `src-tauri/src/keychain.rs` first.</p>
     *
     * <p>Asserted on the <b>present</b> answer specifically. The plugin is consulted on the absent
     * path - see the cross-check tests below - and only ever to contradict an absence, never to
     * provide a value, so "the plugin is not read" is now precisely "the plugin is not read when the
     * command answered".</p>
     */
    it('never sources a value from the plugin, whose get_item cannot tell absence from failure', async () => {
        const store = setup();
        invoke.mockResolvedValue(present('c3RvcmVkLWtleQ=='));

        expect(await store.getItem('alpine_mls_device-7_statekey')).toBe('c3RvcmVkLWtleQ==');

        expect(pluginGetItem).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------------------------------
    // The absence cross-check
    // -----------------------------------------------------------------------------------------------

    /**
     * <b>The net under the one assumption this change cannot prove.</b>
     *
     * <p>`keychain_read` only keeps its promise if it addresses the credential the plugin has been
     * writing. That derivation is argued four ways in `src-tauri/src/keychain.rs` and pinned literally
     * by its tests, and it has <i>never been read back at runtime against an entry the shipped plugin
     * wrote</i>. If it is wrong, `keyring` answers `NoEntry` for an entry that exists, which is a
     * positive absence - so the adapter would report `null`, `localStateKey` would legitimately mint,
     * the real sealed state would fail its AEAD, `classifyMlsStorageFault` would correctly call that
     * corrupt, and every group key on the device would be wiped. On every existing install, on the
     * first launch after the update, silently.</p>
     *
     * <p>Hence: an absence is confirmed against the plugin before it is believed. The tests below pin
     * all three outcomes, because each of the three has a different catastrophe behind getting it
     * wrong - mint over live keys, hide the defect forever, brick every fresh install.</p>
     */
    it('confirms a positive absence against the plugin before it is believed', async () => {
        const store = setup();
        invoke.mockResolvedValue(absent());
        pluginGetItem.mockResolvedValue(null);

        expect(await store.getItem('alpine_mls_device-7_statekey')).toBeNull();

        // The unprefixed key, exactly as the read command got it - the plugin's JS applies
        // `'tauri-storage_'` itself, and passing it pre-prefixed would compare two different entries
        // and never disagree.
        expect(pluginGetItem).toHaveBeenCalledWith('alpine_mls_device-7_statekey');
    });

    /**
     * The disagreement. <b>Rejecting is the point</b>: `null` here is the wipe, and quietly returning
     * the plugin's value would make the app work while leaving the addressing bug - and the entire
     * honest-read path built on top of it - inert and invisible.
     *
     * <p>`''` is included because nothing in this app can write one (the plugin's `set_item` refuses
     * empty data), so a value read back at the plugin's address is a credential existing where this
     * adapter was told none does, whatever its length.</p>
     */
    it.each([
        ['a stored state key', 'c3RvcmVkLWtleQ=='],
        ['an empty string, which nothing here can have written', ''],
    ])('rejects when the plugin can read an entry the command called absent (%s)', async (
        _label,
        pluginValue,
    ) => {
        const store = setup();
        invoke.mockResolvedValue(absent());
        pluginGetItem.mockResolvedValue(pluginValue);

        await expect(store.getItem('alpine_mls_device-7_statekey'))
            .rejects.toThrow(new RegExp(KEYCHAIN_ADDRESS_MISMATCH));
    });

    /** Neither `null` nor the plugin's value: the two failures this rejection exists instead of. */
    it('neither mints over nor silently falls back to the entry the plugin can see', async () => {
        const store = setup();
        invoke.mockResolvedValue(absent());
        pluginGetItem.mockResolvedValue('c3RvcmVkLWtleQ==');

        const outcome = await store.getItem('alpine_mls_device-7_statekey').then(
            value => ({resolved: true, value}),
            () => ({resolved: false, value: undefined}),
        );

        expect(outcome).toEqual({resolved: false, value: undefined});
    });

    /**
     * An absence that could not be corroborated is refused, not trusted.
     *
     * <p>The plugin's IPC failing is the only way to land here, and it breaks `setItem` identically -
     * so a fresh device that reaches this branch could not have written the key it was about to mint
     * either. It fails one line earlier, with a message that says which half is broken.</p>
     */
    it('rejects an absence the plugin could not be asked to confirm', async () => {
        const store = setup();
        invoke.mockResolvedValue(absent());
        pluginGetItem.mockRejectedValue(new Error('secure-storage.get_item denied by capability'));

        await expect(store.getItem('alpine_mls_device-7_statekey'))
            .rejects.toThrow(new RegExp(KEYCHAIN_ABSENCE_UNCONFIRMED));
    });

    /**
     * The cross-check is one IPC, and only on the path where nothing was there to read. A present
     * entry - every launch after the first, for every key that matters - pays nothing.
     */
    it('costs nothing on the present path', async () => {
        const store = setup();
        invoke.mockResolvedValue(present('c3RvcmVkLWtleQ=='));

        await store.getItem('alpine_mls_device-7_statekey');

        expect(invoke).toHaveBeenCalledTimes(1);
        expect(pluginGetItem).not.toHaveBeenCalled();
    });

    /**
     * <b>Both cross-check messages, through the two matchers that decide what they mean.</b>
     *
     * <p>These messages are new prose written by this file, and prose that travels through substring
     * matchers is prose that can be read as something it is not:</p>
     *
     * <ul>
     *   <li>`classifyMlsStorageFault` - the real one, not a copy - must read them as `unknown`. A
     *       message containing any `MLS_STATE_UNREADABLE_MARKERS` substring would classify as corrupt
     *       stored state and license the wipe, which would move the catastrophe rather than remove it;
     *       one containing a `MLS_STATE_KEY_UNAVAILABLE_MARKERS` substring would masquerade as the
     *       engine's own refusal.</li>
     *   <li>`MlsService`'s `isCommandNotFound` must not read them as an absent command, or a caller
     *       going through `callOptional` degrades to silence - the one outcome worse than rejecting,
     *       because it is the outcome that looks fine.</li>
     * </ul>
     */
    it.each([
        [
            'the addressing disagreement',
            KEYCHAIN_ADDRESS_MISMATCH,
            () => pluginGetItem.mockResolvedValue('c3RvcmVkLWtleQ=='),
        ],
        [
            'an absence the plugin could not confirm',
            KEYCHAIN_ABSENCE_UNCONFIRMED,
            // Worded as Tauri words a rejected permission, which is the realistic way to reach this
            // branch and the reason the cause is attached rather than pasted into the message: it
            // contains "not allowed", and that phrase must not reach `isCommandNotFound`.
            () => pluginGetItem.mockRejectedValue(
                new Error('secure-storage.get_item not allowed. Permissions associated with this '
                    + 'command: secure-storage:allow-get-item'),
            ),
        ],
    ])('classifies as transient and stays readable as itself (%s)', async (_label, token, arrange) => {
        const store = setup();
        invoke.mockResolvedValue(absent());
        arrange();

        const err = await rejectionFrom(store, 'alpine_mls_device-7_statekey');
        const message = err instanceof Error ? err.message : String(err);

        // Its own signal, distinct from a generic keychain failure, so a log or a telemetry counter can
        // pick this condition out rather than averaging it into the pile.
        expect(message).toContain(token);

        const fault = classifyMlsStorageFault(err);
        expect(fault.kind).toBe('unknown');
        expect(fault.mayWipe).toBe(false);
        expect(fault.retryable).toBe(true);

        for (const marker of [...MLS_STATE_UNREADABLE_MARKERS, ...MLS_STATE_KEY_UNAVAILABLE_MARKERS]) {
            expect(message).not.toContain(marker);
        }
        // Copied from `isCommandNotFound` in `mls.service.ts`, which pairs it with the command's own
        // name. Matched here without that pairing, because the phrases are what must never appear.
        expect(message).not.toMatch(/not\s+found|unknown command|not\s+allowed/i);
    });

    /**
     * The cross-check reads through the plugin's `get_item`, so the capability that permits it has to
     * stay granted - and it is now the <b>only</b> thing in the app that reads through the plugin,
     * which makes `allow-get-item` look exactly like dead permission surface to anyone tidying up.
     *
     * <p>Pruning it would not present as a permission problem. Every absent read would reject, so
     * existing installs (whose entries are present) would be unaffected and <b>every fresh install
     * would fail to launch</b> - discovered in QA at best, in the wild at worst. Read off disk rather
     * than trusted to a comment, on the same reasoning as `mls-storage-init.spec.ts`.</p>
     */
    it('keeps the capability its cross-check reads through', () => {
        const dir = capabilitiesDir();
        const granting = fs.readdirSync(dir)
            .filter(name => name.endsWith('.json'))
            .map(name => ({name, permissions: permissionsIn(path.join(dir, name))}))
            .filter(({permissions}) => permissions.some(p => p.startsWith('secure-storage:')));

        // The desktop windows all carry secure storage; a run that matched none would be a green test
        // asserting nothing, which is the failure mode of every check that reads files off disk.
        expect(granting.length).toBeGreaterThan(0);

        for (const {name, permissions} of granting) {
            expect(
                permissions.includes('secure-storage:default')
                || permissions.includes('secure-storage:allow-get-item'),
                `${name} grants secure-storage without read access, which breaks the absence `
                + 'cross-check in platform/tauri/secure-store.ts and with it every fresh install',
            ).toBe(true);
        }
    });

    /**
     * An answer the command cannot produce is a boundary that is not behaving as declared - a renamed
     * field, a stale binary, an `invoke` that resolved `undefined`. Every one of these is a *read that
     * did not happen*, and the single most dangerous thing this adapter could do with one is call it
     * absence.
     *
     * <p>`{absent: false, data: null}` is in the list on purpose: it is the shape a truthiness test
     * would collapse into "nothing stored". `{data: null}` with no flag is what a dropped field looks
     * like.</p>
     */
    it.each([
        ['a resolved undefined', undefined],
        ['a resolved null', null],
        ['no absent flag', {data: null}],
        ['absent false with no data', {absent: false, data: null}],
        ['absent true carrying data', {absent: true, data: 'c3RvcmVkLWtleQ=='}],
        ['a non-string payload', {absent: false, data: 42}],
        ['the plugin\'s old shape', {data: 'c3RvcmVkLWtleQ=='}],
    ])('rejects an unrecognised command answer (%s) rather than reading it as absence', async (
        _label,
        answer,
    ) => {
        const store = setup();
        invoke.mockResolvedValue(answer);

        await expect(store.getItem('alpine_mls_device-7_statekey')).rejects.toThrow(/keychain_read/);
    });

    /**
     * <b>The end of the wipe path, asserted rather than reasoned about.</b>
     *
     * <p>Rejecting is only half the fix. The rejection travels out of `MlsService.localStateKey`
     * uncaught and is read by `classifyMlsStorageFault`, and that function decides whether the launch
     * is allowed to delete this device's MLS state. A message that happened to contain one of
     * `MLS_STATE_UNREADABLE_MARKERS` would classify as `state-unreadable`, `mayWipe` would be true, and
     * the change would have moved the catastrophe rather than removed it - which is not hypothetical,
     * because these strings are new and are written by `keychain.rs` rather than by the engine.</p>
     *
     * <p>Both of this adapter's own failure messages are checked: the one relayed from the command, and
     * the one it raises itself for an answer it does not recognise.</p>
     */
    it.each([
        [
            'a keyring failure relayed from the command',
            new Error(
                'could not read keychain entry "tauri-storage_alpine_mls_device-7_statekey": '
                + 'keyring::Error::BadEncoding: Data is not UTF-8 encoded',
            ),
        ],
        ['an answer this adapter does not recognise', undefined],
    ])('classifies as transient, so nothing is wiped (%s)', async (_label, failure) => {
        const store = setup();
        if (failure) invoke.mockRejectedValue(failure);
        else invoke.mockResolvedValue({data: null});

        const err = await store.getItem('alpine_mls_device-7_statekey').then(
            value => {
                throw new Error(`expected a rejection, got ${JSON.stringify(value)}`);
            },
            (cause: unknown) => cause,
        );

        const fault = classifyMlsStorageFault(err);
        expect(fault.mayWipe).toBe(false);
        expect(fault.retryable).toBe(true);
        expect(fault.kind).toBe('unknown');
    });

    /**
     * The factory is what decides that any of the above applies to a desktop install. Without this the
     * whole file could be green against an adapter nothing constructs.
     */
    it('is the adapter a Tauri host is given', () => {
        expect(createSecureStore('tauri')).toBeInstanceOf(TauriSecureStore);
    });

    it('propagates a failed write, so a caller holding key material knows it was not stored', async () => {
        const store = setup();
        const failure = new Error('Data not found');
        setItem.mockRejectedValue(failure);

        await expect(store.setItem('alpine_master_key', 'd3JhcHBlZA==')).rejects.toBe(failure);
    });

    /**
     * Writes deliberately stayed on the plugin. Its `set_item` and `remove_item` already propagate
     * their errors - only reads lied - and moving them would change both the error text callers see and
     * the fact that `remove_item` rejects for an entry that is not there, which
     * `MlsService.clearStoredSigningKey` depends on the current shape of. Pinned so "move the writes
     * too, for symmetry" is a decision someone has to make on purpose.
     */
    it('still writes and deletes through the plugin', async () => {
        const store = setup();

        await store.setItem('alpine_master_key', 'd3JhcHBlZA==');
        await store.removeItem('alpine_master_key');

        expect(setItem).toHaveBeenCalledWith('alpine_master_key', 'd3JhcHBlZA==');
        expect(removeItem).toHaveBeenCalledWith('alpine_master_key');
        expect(invoke).not.toHaveBeenCalled();
    });
});
