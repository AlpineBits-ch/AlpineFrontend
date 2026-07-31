import {inject, Injectable} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {HttpClient, HttpParams} from '@angular/common/http';
import {
    isPermissionGranted,
    registerForPushNotifications,
    requestPermission,
} from '@choochmeque/tauri-plugin-notifications-api';
import {type as osType} from '@tauri-apps/plugin-os';
import {LazyStore} from '@tauri-apps/plugin-store';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';

const STORE_FILE = 'settings.json';
const PUSH_TOKEN_KEY = 'push_token';

/** Transports the backend accepts. `Fcm` covers Android notifications and the Android call ring. */
type PushKind = 'Fcm' | 'ApnsVoip';

interface StoredPushToken {
    token: string;
    kind: PushKind;
}

@Injectable({
    providedIn: 'root',
})
export class UserTokenService {
    private client = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);
    private deviceIdentity = inject(DeviceIdentityService);

    public async ensureTokenRegistered(): Promise<void> {
        let permissionGranted = await isPermissionGranted();
        if (!permissionGranted) {
            const permission = await requestPermission();
            permissionGranted = permission === 'granted';
        }
        try {
            const token = await registerForPushNotifications();
            const kind = this.pushKind();

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

    private pushTokenUrl(): string {
        return `${this.apiConfig.baseUrl()}/api/v1/identity/users/self/push-token`;
    }

    /** iOS needs the PushKit token CallKit rings from; everything else uses Firebase. */
    private pushKind(): PushKind {
        return osType() === 'ios' ? 'ApnsVoip' : 'Fcm';
    }

    private async storedToken(): Promise<StoredPushToken | null> {
        const store = new LazyStore(STORE_FILE);
        return (await store.get<StoredPushToken>(PUSH_TOKEN_KEY)) ?? null;
    }

    private async rememberToken(value: StoredPushToken): Promise<void> {
        const store = new LazyStore(STORE_FILE);
        await store.set(PUSH_TOKEN_KEY, value);
        await store.save();
    }

    private async forgetToken(): Promise<void> {
        const store = new LazyStore(STORE_FILE);
        await store.delete(PUSH_TOKEN_KEY);
        await store.save();
    }
}
