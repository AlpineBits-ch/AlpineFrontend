import {SecureStore} from '../ports/secure-store.port';

/**
 * The signal for "the two readers of one credential do not agree that it is missing".
 *
 * The wording must not contain any marker string the MLS storage classifiers match on.
 */
export const KEYCHAIN_ADDRESS_MISMATCH = 'KEYCHAIN_ADDRESS_MISMATCH';

/** The signal for "the command said absent and the plugin could not be asked to confirm it". */
export const KEYCHAIN_ABSENCE_UNCONFIRMED = 'KEYCHAIN_ABSENCE_UNCONFIRMED';

/**
 * {@link SecureStore} over the OS keychain.
 *
 * Reads go through the local `keychain_read` command; writes go through
 * `tauri-plugin-secure-storage`. Both must address the same credential, so a key renamed on one side
 * has to be renamed on the other.
 *
 * `null` means only that the store was reachable and reported no such entry. A failed read rejects.
 */
export class TauriSecureStore extends SecureStore {
    /** The keychain (Stronghold / the OS keyring) is doing the protecting, not this process. */
    readonly hardwareBacked = true;

    /**
     * The stored string, or `null` only when the store reported no such entry. Rejects on anything else.
     *
     * TODO: add `KEY_SETUP.KEYCHAIN_UNREADABLE`, shown when the fault message names
     * `keyring::Error::NoStorageAccess`, so a locked credential store says so instead of showing the
     * generic retry banner.
     * TODO: add `KEY_SETUP.KEYCHAIN_ADDRESS_MISMATCH`, shown when the fault message contains
     * {@link KEYCHAIN_ADDRESS_MISMATCH}, telling the user their keys are intact. Both strings live in
     * the locales submodule and need their own commit.
     */
    async getItem(key: string): Promise<string | null> {
        const {invoke} = await import('@tauri-apps/api/core');
        const answer = await invoke<KeychainRead>('keychain_read', {key});

        // Both branches must stay positively checked; neither is a fallback for the other.
        if (answer?.absent === true && answer.data == null) return this.confirmAbsence(key);
        if (answer?.absent === false && typeof answer.data === 'string') return answer.data;

        throw new Error(
            `keychain_read("${key}") answered ${JSON.stringify(answer)}, which is neither ` +
                `{absent: true, data: null} nor {absent: false, data: string}. Treating an ` +
                `unrecognised answer as "no entry" is how a readable keychain gets minted over - see ` +
                `src-tauri/src/keychain.rs.`,
        );
    }

    /**
     * `null`, but only once the plugin agrees there is nothing there.
     *
     * Any string counts as presence, including `''`.
     */
    private async confirmAbsence(key: string): Promise<null> {
        let stored: string | null;
        try {
            stored = await (await plugin()).secureStorage.getItem(key);
        } catch (err: unknown) {
            // Logged, not folded into the thrown message: a Tauri rejection reads "not allowed",
            // which must never appear in a message `MlsService` classifies.
            console.error(
                `${KEYCHAIN_ABSENCE_UNCONFIRMED}: the plugin could not confirm that ` +
                    `"${key}" is missing from the keychain.`,
                err,
            );
            throw new Error(
                `${KEYCHAIN_ABSENCE_UNCONFIRMED}: keychain_read("${key}") reported no such entry, and ` +
                    `tauri-plugin-secure-storage - which wrote every entry this app has stored - could ` +
                    `not be asked to confirm it. The cause is attached and logged. Absence is the single ` +
                    `answer that licenses MlsService.localStateKey to mint a fresh state key over this ` +
                    `device's keys, and it is only as trustworthy as the comparison behind it, so an ` +
                    `absence that could not be corroborated is refused rather than acted on. Check, in ` +
                    `this order: that the desktop capabilities still grant "secure-storage:default" ` +
                    `(its allow-get-item is what this cross-check reads through), that the plugin is ` +
                    `still registered in src-tauri/src/lib.rs, that its module still resolves.`,
                {cause: err},
            );
        }

        if (stored == null) return null;

        throw new Error(
            `${KEYCHAIN_ADDRESS_MISMATCH}: keychain_read("${key}") reported no such entry, while ` +
                `tauri-plugin-secure-storage read a ${stored.length}-character value for the same key. ` +
                `Two readers of one credential cannot both be right, and the plugin is the one that ` +
                `wrote it - so the (service, user) derivation in src-tauri/src/keychain.rs is addressing ` +
                `something else, and keyring is answering NoEntry for a credential that exists. This ` +
                `adapter will not answer null (that is what lets MlsService.localStateKey mint a fresh ` +
                `state key over a device still holding the real one, costing it every group key and ` +
                `every cached message it has), and deliberately does not hand back the plugin's value ` +
                `either - a quiet fallback here would work, and would therefore leave this bug in place ` +
                `permanently with the honest-read path above it doing nothing. Fix the derivation ` +
                `against the plugin's: see "One entry, two callers" in ` +
                `src/app/platform/tauri/secure-store.ts.`,
        );
    }

    async setItem(key: string, value: string): Promise<void> {
        await (await plugin()).secureStorage.setItem(key, value);
    }

    async removeItem(key: string): Promise<void> {
        await (await plugin()).secureStorage.removeItem(key);
    }
}

/** The wire shape of `keychain_read`. Mirrors `KeychainRead` in `src-tauri/src/keychain.rs`. */
interface KeychainRead {
    readonly absent: boolean;
    readonly data: string | null;
}

type SecureStoragePlugin = typeof import('tauri-plugin-secure-storage-api');

let loading: Promise<SecureStoragePlugin> | undefined;

/**
 * The plugin module, imported once. Writes, plus the one read that cross-checks an absence.
 *
 * A failed import must not be memoised, or one bad chunk fetch poisons the session.
 */
function plugin(): Promise<SecureStoragePlugin> {
    loading ??= import('tauri-plugin-secure-storage-api').catch((err: unknown) => {
        loading = undefined;
        throw err;
    });
    return loading;
}
