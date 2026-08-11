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

import {classifyMlsStorageFault} from '../../features/main-page/mls-storage-init';
import {createSecureStore} from '../secure-store-factory';
import {TauriSecureStore} from './secure-store';

/** The command's "present" answer. */
function present(data: string): unknown {
    return {absent: false, data};
}

/** The command's "absent" answer - the only one that licenses a `null`. */
function absent(): unknown {
    return {absent: true, data: null};
}

function setup(): TauriSecureStore {
    invoke.mockReset();
    setItem.mockReset();
    removeItem.mockReset();
    pluginGetItem.mockReset();
    setItem.mockResolvedValue(undefined);
    removeItem.mockResolvedValue(undefined);
    return new TauriSecureStore();
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
     * The read path never touches the plugin any more, and this is the test that documents why.
     *
     * <p>The plugin's `getItem` cannot distinguish absence from failure - one line of `desktop.rs`,
     * `Err(_) => Ok(GetItemResponse { data: None })` - so routing a read through it would silently
     * restore the key-loss path regardless of how careful everything above it was. A reviewer moving
     * this back for symmetry with the writes should read `src-tauri/src/keychain.rs` first.</p>
     */
    it('never reads through the plugin, whose get_item cannot tell absence from failure', async () => {
        const store = setup();
        invoke.mockResolvedValue(absent());

        await store.getItem('alpine_mls_device-7_statekey');

        expect(pluginGetItem).not.toHaveBeenCalled();
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
