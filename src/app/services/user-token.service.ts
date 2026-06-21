import {inject, Injectable} from '@angular/core';
import {firstValueFrom, Observable} from "rxjs";
import {HttpClient} from "@angular/common/http";
import {
    isPermissionGranted,
    registerForPushNotifications,
    requestPermission,
} from "@choochmeque/tauri-plugin-notifications-api";
import {environment} from "../../environments/environment";
import {WikiDto} from "../dtos/response/wiki.dto";
import {ApiConfigService} from "./api-config.service";

@Injectable({
    providedIn: 'root',
})
export class UserTokenService {
    private client = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    public async ensureTokenRegistered(): Promise<void> {
        let permissionGranted = await isPermissionGranted();
        if (!permissionGranted) {
            const permission = await requestPermission();
            permissionGranted = permission === 'granted';
        }
        try {
            const token = await registerForPushNotifications();
            console.log('Push token:', token);

            await firstValueFrom(this.client.post(this.apiConfig.baseUrl() + '/api/v1/identity/users/self/device-token', {
                token
            }));
            // Send this token to your server to send push notifications
        } catch (error) {
            console.error('Failed to register for push notifications:', error);
        }
    }
}
