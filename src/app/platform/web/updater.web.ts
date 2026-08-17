import {AvailableUpdate, Updater, UpdateProgress} from '../ports/updater.port';

/**
 * A web client updates by being reloaded, so there is nothing here to replace.
 *
 * <p><b>{@link check} rejects rather than resolving `null`, and that is the important line in this
 * file.</b> `null` from this port means "checked, and you are already current" - the single most
 * dangerous thing a stub could return. It is indistinguishable from a successful check, so it would
 * report a client as up to date forever without anything ever having looked, and the one symptom
 * ("Venta says it is current and it is three versions behind") is invisible from the inside. A
 * rejection is the honest shape: the check did not happen. The port's own contract allows exactly
 * this - "rejects only when the check itself failed".</p>
 *
 * <p>Note this deliberately reads differently from `updater.port.ts`'s summary, which says the web
 * adapter's `check` "resolves null". Resolving null is the thing this file exists not to do; the
 * `supported` flag is what tells a caller the surface is absent, and the design spec's rule for the
 * updater is that the page is <i>hidden</i> on web, so nothing should be calling this at all.</p>
 */
export class WebUpdater extends Updater {
    readonly supported = false;

    check(): Promise<AvailableUpdate | null> {
        return unsupported('check');
    }

    downloadAndInstall(_onProgress?: (p: UpdateProgress) => void): Promise<void> {
        return unsupported('downloadAndInstall');
    }
}

function unsupported(operation: string): Promise<never> {
    return Promise.reject(
        new Error(
            `Updater.${operation}() is desktop-only; a web client updates by being reloaded. ` +
                'Gate on Updater.supported or PlatformCapabilities.selfUpdate.',
        ),
    );
}
