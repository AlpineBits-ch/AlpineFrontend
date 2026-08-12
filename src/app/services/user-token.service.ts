import {inject, Injectable} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {HttpClient, HttpParams} from '@angular/common/http';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';
import {SETTINGS_FILE} from './settings-store';
import {Notifier, PushTokenKind} from '../platform/ports/notifier.port';
import {SettingsStore, SettingsStoreFactory} from '../platform/ports/settings-store.port';

/**
 * Where the push token is kept.
 *
 * <p><b>Outside Tauri this key lands in `localStorage`, which is a weaker posture than the Tauri
 * store file it normally uses.</b> A push token is a capability: whoever holds it can be targeted,
 * and can have this installation's registration deleted. In a browser it is readable by anything
 * running on the origin, and there is no keychain to put it in instead.</p>
 *
 * <p><b>That tradeoff used to be excused by the browser branch never reaching a user, and that excuse
 * is gone.</b> The browser build is now a public web client (see the browser-only build design), so
 * the reasoning has to stand on its own, and it does - but for a narrower reason than before, in two
 * parts:</p>
 * <ul>
 *   <li><b>Today there is nothing here to steal on web.</b> `Notifier.pushToken()` returns null in a
 *       browser, so this key is never written outside Tauri. The only web write that can happen is
 *       none. What is documented below is what becomes true the day Web Push lands, not what is true
 *       now.</li>
 *   <li><b>When it does land, browser storage is the only option there is.</b> A Web Push
 *       subscription is minted by the browser and has to be re-read to be deregistered; there is no
 *       keychain on the platform to hold it. The mitigations are the ones the design spec commits to
 *       for all web key material - a per-device registration that can be revoked without touching any
 *       other session, and a tight CSP as the primary defence, since XSS on the origin is the threat
 *       that matters. A stolen subscription lets an attacker send this browser notifications and
 *       delete its registration; it does not read messages, which are E2EE.</li>
 * </ul>
 *
 * <p>Nothing in this service should be read as a claim that browser push storage is safe.</p>
 */
const PUSH_TOKEN_KEY = 'push_token';

interface StoredPushToken {
    token: string;
    kind: PushTokenKind;
}

@Injectable({
    providedIn: 'root',
})
export class UserTokenService {
    private client = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);
    private deviceIdentity = inject(DeviceIdentityService);
    private notifier = inject(Notifier);
    private settings = inject(SettingsStoreFactory);

    public async ensureTokenRegistered(): Promise<void> {
        // Asked for the prompt, not as a gate. This has never gated registration - the permission
        // result was computed and deliberately unused - because a permission grant and a usable
        // transport token are different things: the mint below is the real gate, and a user who
        // dismissed the prompt can still hold a token from an earlier grant.
        await this.notifier.requestPermission();

        try {
            // Token first, kind second, and that order is load-bearing on desktop: the kind is the
            // one synchronous answer the port gives, and the Tauri adapter resolves what it needs to
            // answer it during the same warm-up that `pushToken()` awaits.
            const token = await this.notifier.pushToken();
            const kind = this.notifier.pushTokenKind();

            if (!token || !kind) {
                // **Nothing is posted and nothing is stored.** This is the browser's path today, and
                // the whole point of it being silent: a device row holding a `WebPush` kind with no
                // usable endpoint would be picked as a delivery target and drop every notification
                // sent to it, which looks like a server fault rather than a missing feature. Sign-in
                // is unaffected - the caller is fire-and-forget from launch either way.
                console.info(`Push not registered: ${this.noTokenReason(token, kind)}.`);
                return;
            }

            // The device id is what lets the server leave out the device already handling an
            // event - without it the token can be neither targeted nor cleaned up.
            await firstValueFrom(this.client.post(this.pushTokenUrl(), {
                token,
                kind,
                deviceId: await this.deviceIdentity.deviceId(),
            }));

            await this.rememberToken({token, kind});
        } catch (error) {
            console.error('Failed to register for push notifications:', error);
        }
    }

    /**
     * Stops this installation being rung after sign-out. The token value has to come from our own
     * store: by the time logout runs, asking the push plugin for it again is not dependable.
     */
    public async deregisterToken(): Promise<void> {
        try {
            const stored = await this.storedToken();
            if (!stored) return;

            const params = new HttpParams()
                .set('token', stored.token)
                .set('kind', stored.kind);

            await firstValueFrom(this.client.delete(this.pushTokenUrl(), {params}));
            await this.forgetToken();
        } catch (error) {
            console.error('Failed to deregister push token:', error);
        }
    }

    /**
     * Why nothing was registered, in one line, for the console.
     *
     * <p>Named rather than logged inline because the browser case is the interesting one and needs to
     * name all three missing pieces: someone reading this line while wondering why a web client is
     * silent should not have to find the design spec to learn that the gap is server-side.</p>
     */
    private noTokenReason(token: string | null, kind: PushTokenKind | null): string {
        if (kind === null) return 'this host takes no push at all';
        if (kind === 'WebPush') {
            return 'Web Push is not implemented - it needs a service worker, VAPID keys and a server ' +
                'that accepts a WebPush token kind';
        }
        return `this host mints no ${kind} token`;
    }

    private pushTokenUrl(): string {
        return `${this.apiConfig.baseUrl()}/api/v1/identity/users/self/push-token`;
    }

    /** A handle on the shared settings file, opened per use. See {@link SettingsStoreFactory}. */
    private store(): SettingsStore {
        return this.settings.open(SETTINGS_FILE);
    }

    private async storedToken(): Promise<StoredPushToken | null> {
        return (await this.store().get<StoredPushToken>(PUSH_TOKEN_KEY)) ?? null;
    }

    private async rememberToken(value: StoredPushToken): Promise<void> {
        const store = this.store();
        await store.set(PUSH_TOKEN_KEY, value);
        await store.save();
    }

    private async forgetToken(): Promise<void> {
        const store = this.store();
        await store.delete(PUSH_TOKEN_KEY);
        await store.save();
    }
}
