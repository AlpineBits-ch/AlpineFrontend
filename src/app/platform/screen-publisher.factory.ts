import {PlatformHost} from './host';
import {ScreenPublisher} from './ports/screen-publisher.port';
import {TauriScreenPublisher} from './tauri/screen-publisher.tauri';
import {WebScreenPublisher} from './web/screen-publisher.web';

/**
 * The screen publisher for a host.
 *
 * <p>Both adapter <i>classes</i> are imported statically and that is deliberate, not an oversight of the
 * "lazy import" rule. What has to stay lazy is the <b>Tauri IPC module</b>, and
 * `TauriScreenPublisher` only reaches it through an `import()` inside its methods - so a web bundle
 * that constructs neither adapter still never downloads it. Making the class itself lazy would mean the
 * provider could not answer `inject(ScreenPublisher)` synchronously, which every call site expects.</p>
 *
 * <p>Its own file so `provide-platform.ts` gains exactly one import line and one edited block. Several
 * tracks are wiring their own ports in that file concurrently, and a factory inlined there would put
 * two adapter imports into the same hunk as everybody else's.</p>
 */
export function screenPublisherFor(host: PlatformHost): ScreenPublisher {
    return host === 'tauri' ? new TauriScreenPublisher() : new WebScreenPublisher();
}
