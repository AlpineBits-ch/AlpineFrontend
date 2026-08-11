import {SecureStore} from '../ports/secure-store.port';

/**
 * The signal for "the two readers of one credential do not agree that it is missing".
 *
 * <p>A distinct token rather than prose, so this condition is greppable in `venta.log` and countable
 * in telemetry instead of blending into the pile of generic keychain failures. <b>One occurrence is a
 * shipped key-loss bug</b>: it means `keychain_read` is addressing something other than what
 * `tauri-plugin-secure-storage` writes, so every entry on the machine reads as absent - and absence is
 * what licenses `MlsService.localStateKey` to mint over a device's live keys.</p>
 *
 * <p>Deliberately worded to survive the two matchers this message travels through. It contains no
 * substring of `MLS_STATE_UNREADABLE_MARKERS` (which would classify it as corrupt stored state and
 * license the wipe this exists to prevent), none of `MLS_STATE_KEY_UNAVAILABLE_MARKERS` (which would
 * make it look like the engine's own refusal), and nothing `MlsService`'s `isCommandNotFound` reads as
 * a missing command - "not found", "unknown command", "not allowed" - which would degrade it to
 * silence. `secure-store.spec.ts` pins all of that against the real `classifyMlsStorageFault`.</p>
 */
export const KEYCHAIN_ADDRESS_MISMATCH = 'KEYCHAIN_ADDRESS_MISMATCH';

/**
 * The signal for "the command said absent and the plugin could not be asked to confirm it".
 *
 * <p>Refused rather than trusted, which is the same asymmetry the rest of this file is built on: this
 * branch costs a launch and a retry banner, and the alternative risks the device's group keys. It is
 * also the branch that cannot be reached by anything routine - it needs the plugin's IPC to fail,
 * while `keychain_read` succeeded for the same two strings a moment earlier, which rules out the
 * plugin's own `Entry::new` unwrap and its `product_name` unwrap panicking.</p>
 *
 * <p><b>Refusing here cannot brick a fresh install.</b> The only way the plugin cannot answer a read
 * is that its IPC is broken - the permission was trimmed out of the desktop capabilities, the plugin
 * was unregistered, its module failed to import - and every one of those breaks
 * {@link TauriSecureStore.setItem} identically. A fresh device that reached this branch was going to
 * fail on the very next line anyway, when the minted state key could not be written; it fails here
 * instead, with a message that says which half is broken. Nothing is wiped either way: like every
 * message in this file, it classifies as `unknown`.</p>
 */
export const KEYCHAIN_ABSENCE_UNCONFIRMED = 'KEYCHAIN_ABSENCE_UNCONFIRMED';

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
 * <h3>Absence is cross-checked against the plugin, and stays cross-checked</h3>
 *
 * <p>The paragraph above is an argument, not an observation: <b>the derivation has never been read
 * back at runtime against a credential the shipped plugin actually wrote.</b> If it is wrong in any
 * way - a prefix, the service, a second `keyring` compiled in beside ours with a different default
 * builder - then `keyring` answers `NoEntry` for an entry that is sitting right there, this adapter
 * reports a <i>positive</i> absence, `localStateKey` mints, the real sealed state fails to
 * authenticate, the classifier correctly says "corrupt", and the state is wiped. On every existing
 * desktop install, on the first launch after the update, silently. The honest-error work above turns
 * that failure mode into the exact catastrophe it was written to prevent.</p>
 *
 * <p>So absence is not taken on trust. When `keychain_read` reports it, {@link
 * TauriSecureStore.getItem} asks `tauri-plugin-secure-storage` - <b>the reader that has been writing
 * these entries all along, and therefore the one that is right by definition</b> - for the same key:</p>
 *
 * <ul>
 *   <li>Plugin reports nothing too: a genuine absence, and the only answer that may mint. This is the
 *       common path (a fresh device, or a key that was never set) and costs one extra IPC.</li>
 *   <li>Plugin returns a value: the two disagree, which can only mean they are not addressing the
 *       same credential. <b>Rejects</b>, with {@link KEYCHAIN_ADDRESS_MISMATCH} in the message.
 *       Returning `null` would be the wipe; quietly returning the plugin's value instead would work
 *       and would therefore hide the defect forever, leaving the whole honest-error path inert while
 *       looking healthy. A read path is the wrong place to paper over a naming bug.</li>
 *   <li>Plugin could not be asked: rejects with {@link KEYCHAIN_ABSENCE_UNCONFIRMED}. See that
 *       constant for why an unconfirmable absence is refused rather than trusted, and why refusing
 *       cannot brick a fresh install.</li>
 * </ul>
 *
 * <p><b>Permanent, not a migration scaffold.</b> A one-off runtime confirmation would only ever
 * describe the binary that was confirmed. What the disagreement actually detects is "the plugin's
 * idea of the address moved away from ours", and both halves of the plugin's derivation are its own
 * private implementation detail: `this.prefix` in its JS, `Entry::new(product_name, prefixedKey)` in
 * its Rust, and - the sharp one - <i>which `keyring` it links</i>. A plugin release that bumps
 * `keyring` while our direct dependency stays put compiles two of them into the binary, each with its
 * own process-global default credential builder, and the entries silently part company. `bun update`
 * is enough. The check is the only thing that would notice, so it stays.</p>
 *
 * <p><b>An empty key</b> used to be answered `null` by the plugin's JS without invoking anything - the
 * same conflation in miniature. It now reaches the command and is answered honestly (absent, or a
 * `keyring` `Invalid`). No caller passes one: every key in the app is built from a prefix and a device
 * id. Note that the cross-check is vacuous for one, because the plugin's JS still short-circuits it -
 * which is harmless, and is another reason not to start passing empty keys.</p>
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
     * refuses to produce one unless Rust positively asserted absence <b>and the plugin that wrote
     * these entries agrees</b> - see {@link TauriSecureStore.confirmAbsence}.</p>
     *
     * <p>The messages this method raises are diagnostic, not user-facing: they classify as `unknown`
     * and the launch answers that with its existing retry banner. <b>TODO</b> - the honest answer is
     * now available to say something better than "try again", because a locked credential store is
     * something the user can act on. Proposed key `KEY_SETUP.KEYCHAIN_UNREADABLE`: "Your device's
     * keychain could not be read, so your encryption keys are locked away rather than lost. Unlock it
     * and try again." Shown when the fault message names `keyring::Error::NoStorageAccess`. Not added
     * here - strings live in the locales submodule and need their own commit.</p>
     *
     * <p><b>TODO</b> - {@link KEYCHAIN_ADDRESS_MISMATCH} needs a different string again, because the
     * retry banner is a lie for it: a naming bug does not lift on the next attempt, and the one thing
     * the user needs told is that their keys are intact. Proposed key
     * `KEY_SETUP.KEYCHAIN_ADDRESS_MISMATCH`: "Your encryption keys are still on this device, but this
     * version cannot open them. Nothing has been deleted. Please update Venta, and contact support if
     * this keeps happening." Shown when the fault message contains `KEYCHAIN_ADDRESS_MISMATCH`. Same
     * reason it is not added here.</p>
     */
    async getItem(key: string): Promise<string | null> {
        const {invoke} = await import('@tauri-apps/api/core');
        const answer = await invoke<KeychainRead>('keychain_read', {key});

        // Both branches are checked positively, and neither is a fallback for the other. `absent`
        // being a flag rather than "data happens to be null" is what makes a dropped or renamed field
        // fall through to the throw below instead of reading as a fresh device.
        if (answer?.absent === true && answer.data == null) return this.confirmAbsence(key);
        if (answer?.absent === false && typeof answer.data === 'string') return answer.data;

        throw new Error(
            `keychain_read("${key}") answered ${JSON.stringify(answer)}, which is neither `
            + `{absent: true, data: null} nor {absent: false, data: string}. Treating an `
            + `unrecognised answer as "no entry" is how a readable keychain gets minted over - see `
            + `src-tauri/src/keychain.rs.`,
        );
    }

    /**
     * `null`, but only once the plugin agrees there is nothing there.
     *
     * <p><b>Why the plugin is the authority on this one question.</b> It wrote every entry this app has
     * ever stored, so whatever address it reads is by definition the address the data is at. It cannot
     * be trusted to report a <i>failure</i> - that is the whole defect, `Err(_) => data: None` - but
     * "the plugin can see a value" is a positive fact, and it is the one fact that proves an absence
     * reported by `keychain_read` is a lie. The two directions of its unreliability point the same way
     * here: the plugin under-reports presence and never over-reports it, so this cross-check can raise
     * a false alarm only for a value that genuinely exists, never miss a value that does.</p>
     *
     * <p>Any string counts as presence, including `''`. Nothing in this app can write one - the
     * plugin's `set_item` refuses empty data - so an empty value read back at the plugin's address is
     * still a credential existing where this adapter was told none does.</p>
     *
     * <p>The two reads are not atomic, so another window minting the same key in the microsecond
     * between them would present as a disagreement. That costs one refused read and a retry, after
     * which the entry reads as present through both paths; it cannot cost anything more, which is the
     * direction to be wrong in.</p>
     */
    private async confirmAbsence(key: string): Promise<null> {
        let stored: string | null;
        try {
            stored = await (await plugin()).secureStorage.getItem(key);
        } catch (err: unknown) {
            // Logged as well as attached: the launch logs `fault.message` alone, and the reason the
            // plugin could not answer is the whole diagnostic value of this branch. Kept out of the
            // message itself so the text that reaches the classifiers is only ever this file's own -
            // a Tauri permission rejection reads "... not allowed ...", which is one of the phrases
            // that must not appear in a message `MlsService` might see.
            console.error(
                `${KEYCHAIN_ABSENCE_UNCONFIRMED}: the plugin could not confirm that `
                + `"${key}" is missing from the keychain.`,
                err,
            );
            throw new Error(
                `${KEYCHAIN_ABSENCE_UNCONFIRMED}: keychain_read("${key}") reported no such entry, and `
                + `tauri-plugin-secure-storage - which wrote every entry this app has stored - could `
                + `not be asked to confirm it. The cause is attached and logged. Absence is the single `
                + `answer that licenses MlsService.localStateKey to mint a fresh state key over this `
                + `device's keys, and it is only as trustworthy as the comparison behind it, so an `
                + `absence that could not be corroborated is refused rather than acted on. Check, in `
                + `this order: that the desktop capabilities still grant "secure-storage:default" `
                + `(its allow-get-item is what this cross-check reads through), that the plugin is `
                + `still registered in src-tauri/src/lib.rs, that its module still resolves.`,
                {cause: err},
            );
        }

        if (stored == null) return null;

        throw new Error(
            `${KEYCHAIN_ADDRESS_MISMATCH}: keychain_read("${key}") reported no such entry, while `
            + `tauri-plugin-secure-storage read a ${stored.length}-character value for the same key. `
            + `Two readers of one credential cannot both be right, and the plugin is the one that `
            + `wrote it - so the (service, user) derivation in src-tauri/src/keychain.rs is addressing `
            + `something else, and keyring is answering NoEntry for a credential that exists. This `
            + `adapter will not answer null (that is what lets MlsService.localStateKey mint a fresh `
            + `state key over a device still holding the real one, costing it every group key and `
            + `every cached message it has), and deliberately does not hand back the plugin's value `
            + `either - a quiet fallback here would work, and would therefore leave this bug in place `
            + `permanently with the honest-read path above it doing nothing. Fix the derivation `
            + `against the plugin's: see "One entry, two callers" in `
            + `src/app/platform/tauri/secure-store.ts.`,
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
 * The plugin module, imported once. Writes, plus the one read that cross-checks an absence.
 *
 * <p>Reads no longer <i>come from</i> here - `getItem` sources every value from `keychain_read`, and
 * {@link TauriSecureStore.confirmAbsence} consults the plugin only to contradict an absence, never to
 * supply a value. The distinction is the point of the whole change and is pinned by the spec.</p>
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
