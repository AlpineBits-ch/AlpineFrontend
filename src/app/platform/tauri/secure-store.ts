import {SecureStore} from '../ports/secure-store.port';

/**
 * {@link SecureStore} over the OS keychain.
 *
 * <p>The same store the MLS signing keys, the wrapped master key and the push token have always been
 * written to, addressing the same entries - so a desktop install that upgrades onto the port layer
 * finds every entry exactly where it left it. Renaming a key here would present as this device being
 * ejected from every group it belongs to, not as a storage bug.</p>
 *
 * <p><b>Reads go through the local `keychain_read` command; writes still go through
 * `tauri-plugin-secure-storage`.</b> Both address the same credential - see "One entry, two callers"
 * below, which is the invariant this file lives or dies by.</p>
 *
 * <p>The plugin is loaded by `import()` on first use rather than at module scope. Nothing else in
 * this adapter is worth deferring; the point is that a browser bundle which never constructs this
 * class never pulls the plugin in either, which is what the boundary rule buys.</p>
 *
 * <h3>What `null` means here</h3>
 *
 * <p><b>It means what the port says it means: the credential store was reachable and reported that no
 * such entry exists.</b> A read that <i>failed</i> rejects. That was not true before, and the
 * difference is the whole reason this file changed.</p>
 *
 * <p>The plugin's desktop `get_item` is:</p>
 *
 * <pre>let data = entry.unwrap().get_password();
 *match data {
 *    Ok(data) =&gt; Ok(GetItemResponse { data: Some(data) }),
 *    Err(_)   =&gt; Ok(GetItemResponse { data: None }),      // every error, collapsed
 *}</pre>
 *
 * <p>(`tauri-plugin-secure-storage` 1.5.0, `src/desktop.rs`.) `keyring` 3.6.3 does distinguish the
 * cases - `NoEntry` for "never set or deleted" against `NoStorageAccess` for a credential store that
 * is locked or unreachable, `PlatformFailure` for a platform call that failed, `BadEncoding` for a
 * blob that is not UTF-8, `Ambiguous` for two credentials matching one entry - and the plugin threw
 * that discrimination away before it reached the IPC boundary. `src-tauri/src/keychain.rs` re-reads
 * the same entry through `keyring` directly and keeps it: `NoEntry` alone becomes absence, every
 * other variant becomes an `Err` naming the variant and the platform error, which arrives here as a
 * rejection. That module's header carries the full argument and the naming proof.</p>
 *
 * <p><b>What the collapse used to cost.</b> `MlsService.localStateKey` mints a fresh state key when
 * this returns `null`. Against a locked keychain that handed the engine the wrong key, the sealed
 * `mls_state.json` then failed to authenticate, and that failure is legitimately on
 * `mls-storage-init.ts`'s corrupt list - so the launch wiped every group key and every message on the
 * device, for a fault that had been recoverable a moment earlier. What partly covered it was luck
 * rather than design: minting immediately writes, and a keychain that cannot be read usually cannot
 * be written either, so `setItem` tended to reject first. The residual hole was a store whose reads
 * fail while its writes succeed - `BadEncoding`, `Ambiguous`, or a secret-service collection whose
 * read fails and whose write prompts an unlock and then succeeds. Those are exactly the cases the
 * command now reports as failures.</p>
 *
 * <h3>One entry, two callers</h3>
 *
 * <p>Reads moved and writes did not, so the two must agree on the address of every entry. They do,
 * because `keychain.rs` reproduces both halves of the plugin's derivation - the JS wrapper's
 * `'tauri-storage_' + key`, and Rust's `Entry::new(productName, prefixedKey)` - and hands them to the
 * same `keyring::Entry::new`, in the same process, against the same single compiled `keyring` and its
 * process-global default credential builder. That module's tests pin the prefix and the composed pair
 * literally.</p>
 *
 * <p><b>Why writes stayed on the plugin</b>, rather than moving for symmetry. The plugin's `set_item`
 * and `remove_item` already propagate their errors - only reads lied - so moving them buys no safety.
 * It would however change two observable behaviours for no reason: the error text callers currently
 * see, and the fact that `remove_item` rejects for an entry that is not there (its `delete_credential`
 * returns `NoEntry`, which the plugin turns into an error). `MlsService.clearStoredSigningKey` deletes
 * five entries in a `Promise.all`, two of which need not exist, so that behaviour is load-bearing in a
 * way this change has no business touching. Every line moved is a line that has to be re-verified;
 * the read path is the one with a key-loss bug in it.</p>
 *
 * <p><b>An empty key</b> used to be answered `null` by the plugin's JS without invoking anything - the
 * same conflation in miniature. It now reaches the command and is answered honestly (absent, or a
 * `keyring` `Invalid`). No caller passes one: every key in the app is built from a prefix and a device
 * id.</p>
 */
export class TauriSecureStore extends SecureStore {
    /** The keychain (Stronghold / the OS keyring) is doing the protecting, not this process. */
    readonly hardwareBacked = true;

    /**
     * The stored string, or `null` <b>only</b> when the store reported no such entry.
     *
     * <p>Rejects on anything else, including a shape from the command that is neither of its two
     * legal answers. The strictness is the point: `MlsService.localStateKey` mints a new state key on
     * `null` and destroys the device's message history if that `null` was a lie, so this method
     * refuses to produce one unless Rust positively asserted absence.</p>
     *
     * <p>The messages this method raises are diagnostic, not user-facing: they classify as `unknown`
     * and the launch answers that with its existing retry banner. <b>TODO</b> - the honest answer is
     * now available to say something better than "try again", because a locked credential store is
     * something the user can act on. Proposed key `KEY_SETUP.KEYCHAIN_UNREADABLE`: "Your device's
     * keychain could not be read, so your encryption keys are locked away rather than lost. Unlock it
     * and try again." Shown when the fault message names `keyring::Error::NoStorageAccess`. Not added
     * here - strings live in the locales submodule and need their own commit.</p>
     */
    async getItem(key: string): Promise<string | null> {
        const {invoke} = await import('@tauri-apps/api/core');
        const answer = await invoke<KeychainRead>('keychain_read', {key});

        // Both branches are checked positively, and neither is a fallback for the other. `absent`
        // being a flag rather than "data happens to be null" is what makes a dropped or renamed field
        // fall through to the throw below instead of reading as a fresh device.
        if (answer?.absent === true && answer.data == null) return null;
        if (answer?.absent === false && typeof answer.data === 'string') return answer.data;

        throw new Error(
            `keychain_read("${key}") answered ${JSON.stringify(answer)}, which is neither `
            + `{absent: true, data: null} nor {absent: false, data: string}. Treating an `
            + `unrecognised answer as "no entry" is how a readable keychain gets minted over - see `
            + `src-tauri/src/keychain.rs.`,
        );
    }

    async setItem(key: string, value: string): Promise<void> {
        await (await plugin()).secureStorage.setItem(key, value);
    }

    async removeItem(key: string): Promise<void> {
        await (await plugin()).secureStorage.removeItem(key);
    }
}

/**
 * The wire shape of `keychain_read`. Mirrors `KeychainRead` in `src-tauri/src/keychain.rs`.
 *
 * <p>Typed as it is declared there rather than defensively - the runtime check in `getItem` is what
 * actually enforces it, because a Tauri command's return value is unvalidated JSON and a type here
 * is an assumption, not a guarantee.</p>
 */
interface KeychainRead {
    readonly absent: boolean;
    readonly data: string | null;
}

type SecureStoragePlugin = typeof import('tauri-plugin-secure-storage-api');

let loading: Promise<SecureStoragePlugin> | undefined;

/**
 * The plugin module, imported once. Writes only - reads no longer touch it.
 *
 * <p>A failed import is <b>not</b> memoised. Caching the rejection would turn one bad chunk fetch
 * into a session that can never store a key again - and the caller most likely to hit it is the one
 * storing a master key, which is precisely the operation that must not be permanently poisoned by a
 * transient failure.</p>
 */
function plugin(): Promise<SecureStoragePlugin> {
    loading ??= import('tauri-plugin-secure-storage-api').catch((err: unknown) => {
        loading = undefined;
        throw err;
    });
    return loading;
}
