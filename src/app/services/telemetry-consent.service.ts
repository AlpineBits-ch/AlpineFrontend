import {effect, inject, Injectable} from '@angular/core';
import * as Sentry from '@sentry/angular';
import {PrivacySettingsService} from './privacy-settings.service';
import {ProfileService} from './profile.service';
import {installId} from '../core/telemetry-privacy';

/** Binds the identity attached to crash reports to the account's consent (T0-4). Upgrades the per-install pseudonym to a real user id only while {@link PrivacySettingsService.allowDataCollection} is true, which is false until the privacy record has loaded. */
@Injectable({providedIn: 'root'})
export class TelemetryConsentService {
    private readonly privacy = inject(PrivacySettingsService);
    private readonly profiles = inject(ProfileService);

    constructor() {
        effect(() => {
            const consented = this.privacy.allowDataCollection();
            const userId = this.profiles.ownProfile()?.userId ?? null;

            // Only ever an opaque id: username and email are scrubbed from events wholesale, and putting them back here would defeat that.
            Sentry.setUser({id: consented && userId ? userId : installId()});
        });
    }

    /** Called on sign-out so the next session does not inherit the previous account's identity. */
    forget(): void {
        Sentry.setUser({id: installId()});
    }
}
