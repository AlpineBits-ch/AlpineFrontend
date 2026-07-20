import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable, Subject} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {UserService} from './user.service';
import {ToastService} from './toast.service';

/** Statuses returned by the `venta://steam-auth` deep link for the link flow. */
export type SteamLinkStatus = 'linked' | 'already_linked' | 'error';

@Injectable({providedIn: 'root'})
export class SteamService {
    /** Emits whenever the Steam link deep link resolves, so open views can refresh. */
    public readonly linkResult = new Subject<SteamLinkStatus>();

    private httpClient = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);
    private userService = inject(UserService);
    private toast = inject(ToastService);

    /** Step 1 of linking: fetch the Steam OpenID redirect URL (bearer added by interceptor). */
    public getLinkStartUrl(): Observable<{ redirectUrl: string }> {
        return this.httpClient.get<{ redirectUrl: string }>(
            `${this.apiConfig.baseUrl()}/api/v1/identity/authentication/steam/link/start`,
        );
    }

    /** Remove the Steam link from the current account. */
    public unlink(): Observable<void> {
        return this.httpClient.delete<void>(
            `${this.apiConfig.baseUrl()}/api/v1/identity/authentication/steam/link`,
        );
    }

    /**
     * Handle the `venta://steam-auth?status=...` deep link for the link flow.
     * Shows a toast and refreshes the user so a freshly linked SteamID is reflected,
     * then re-emits the status for any mounted view.
     */
    public handleLinkCallback(status: string): void {
        switch (status) {
            case 'linked':
                this.toast.success('Steam account linked');
                this.userService.getSelf().subscribe();
                this.linkResult.next('linked');
                break;
            case 'already_linked':
                this.toast.error('That Steam account is already linked to another account');
                this.linkResult.next('already_linked');
                break;
            default:
                this.toast.error('Steam linking failed');
                this.linkResult.next('error');
                break;
        }
    }
}
