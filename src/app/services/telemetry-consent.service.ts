import {effect, inject, Injectable} from '@angular/core';
import * as Sentry from '@sentry/angular';
import {PrivacySettingsService} from './privacy-settings.service';
import {ProfileService} from './profile.service';
import {installId} from '../core/telemetry-privacy';

/**
 * Binds the identity attached to crash reports to the account's consent (T0-4).
 *
 * <p>`main.ts` starts Sentry with a per-install pseudonym because init happens long before anyone
 * is signed in. This service is what upgrades that to a real user id - and only ever while
 * {@link PrivacySettingsService.allowDataCollection} is true. Because that signal is false until
 * the privacy record has actually loaded, an unreachable settings endpoint leaves reports
 * anonymous rather than identified.</p>
 *
 * <p>Withdrawing consent takes effect on the next event: the effect below re-runs and puts the
 * pseudonym back. It cannot unsend what has already gone.</p>
 */
@Injectable({providedIn: 'root'})
export class TelemetryConsentService {
    private readonly privacy = inject(PrivacySettingsService);
    private readonly profiles = inject(ProfileService);

    constructor() {
        effect(() => {
            const consented = this.privacy.allowDataCollection();
            const userId = this.profiles.ownProfile()?.userId ?? null;

            // Only ever an opaque id. Username and email are scrubbed from events wholesale, and
            // putting them back here under the banner of "the user consented" would defeat that -
            // consent was to being identifiable, not to shipping a contact list to a vendor.
            Sentry.setUser({id: consented && userId ? userId : installId()});
        });
    }

    /** Called on sign-out so the next session does not inherit the previous account's identity. */
    forget(): void {
        Sentry.setUser({id: installId()});
    }
}
