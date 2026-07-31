import {inject, Injectable, signal} from '@angular/core';
import {HttpClient, HttpErrorResponse} from '@angular/common/http';
import {environment} from '../../environments/environment';
import {catchError, firstValueFrom, from, map, Observable, of, tap} from 'rxjs';
import {EncryptedMasterKey, UserDto} from '../dtos/response/UserDto';
import {MlsService} from "./mls.service";
import {switchMap} from "rxjs/operators";
import {ApiConfigService} from "./api-config.service";

@Injectable({providedIn: 'root'})
export class UserService {
    private httpClient = inject(HttpClient);
    private mlsService = inject(MlsService);
    private apiConfig = inject(ApiConfigService);

    readonly self = signal<UserDto | null>(null);

    getSelf(): Observable<UserDto> {
        return this.httpClient.get<UserDto>(`${this.apiConfig.baseUrl()}/api/v1/identity/users/self`).pipe(
            tap(user => this.self.set(user))
        );
    }

    verifyPassword(password: string): Observable<boolean> {
        return this.httpClient.post<unknown>(
            `${this.apiConfig.baseUrl()}/api/v1/identity/authentication/verify`,
            {password}
        ).pipe(
            map(() => true),
            catchError(() => of(false))
        );
    }

    uploadEncryptedMasterKey(_payload: EncryptedMasterKey): Observable<void> {

        return this.httpClient.post<void>(
            `${this.apiConfig.baseUrl()}/api/v1/identity/users/master`,
            _payload
        );

    }

    getToGenerateKeyCount(): Observable<{ count: number; needsLastResort: boolean }> {
        return from(this.mlsService.getOrCreateDeviceIdentifier()).pipe(
            switchMap(deviceId => {
                return this.httpClient.get<{
                    count: number;
                    needsLastResort: boolean;
                }>(`${this.apiConfig.baseUrl()}/api/v1/identity/devices/client/${deviceId}/generate`
                )
            })
        )
    }

    changePassword(currentPassword: string, newPassword: string): Observable<{ code: number }> {
        return this.httpClient.put(
            `${this.apiConfig.baseUrl()}/api/v1/identity/users/self/password`,
            {currentPassword, newPassword},
            {observe: 'response'}
        ).pipe(
            map(res => ({code: res.status})),
            catchError((err: HttpErrorResponse) => of({code: err.status ?? 500}))
        );
    }

    signOutAllOtherDevices(): Observable<void> {
        return this.httpClient.post<void>(
            `${this.apiConfig.baseUrl()}/api/v1/identity/sessions/revoke-others`,
            {withinSeconds: 3600}
        );
    }

    deleteAccount(): Observable<UserDto> {
        return this.httpClient.delete<{ purgeScheduledAt: string }>(
            `${this.apiConfig.baseUrl()}/api/v1/identity/users/self`
        ).pipe(
            switchMap(() => this.getSelf())
        );
    }

    cancelDeletion(): Observable<UserDto> {
        return this.httpClient.post<void>(
            `${this.apiConfig.baseUrl()}/api/v1/identity/users/self/cancel-deletion`,
            {}
        ).pipe(
            switchMap(() => this.getSelf())
        );
    }

    public replenishKeyCount(): Observable<void> {
        const handle = this.mlsService.keyHandle();

        if (!handle) {
            console.log('vault not unlocked, cannot replenish key count');
            return of(undefined);
        }

        return from(this.mlsService.getOrCreateDeviceIdentifier()).pipe(
            switchMap(deviceId =>
                this.getToGenerateKeyCount().pipe(
                    switchMap(response =>
                        from(this.buildKeyPackageUpload(handle, response.count, response.needsLastResort)).pipe(
                            switchMap(keyPackages => {
                                if (keyPackages.length === 0) return of(undefined);
                                return this.httpClient.post<void>(
                                    `${this.apiConfig.baseUrl()}/api/v1/identity/devices/client/${deviceId}/key-packages`,
                                    {keyPackages},
                                );
                            }),
                        ),
                    ),
                ),
            ),
            map(() => undefined),
        );
    }

    /**
     * Single-use packages to top the supply back up, plus a last-resort one when the server has
     * none for this device.
     *
     * The last-resort package is reusable and is only handed out once the single-use supply is
     * drained. It exists so a device that ran dry between launches is still addable to a group:
     * without it the server has nothing to offer, and that device is silently left out of every new
     * conversation - readable by everyone except the person holding it.
     */
    private async buildKeyPackageUpload(
        handle: string,
        count: number,
        needsLastResort: boolean,
    ): Promise<{ keyPackage: string; isLastResort?: boolean }[]> {
        const upload: { keyPackage: string; isLastResort?: boolean }[] = [];

        if (count > 0) {
            const packages = await firstValueFrom(this.mlsService.generateAdditionalKeyPackages(handle, count));
            upload.push(...packages.map(p => ({keyPackage: p.keyPackage})));
        }

        if (needsLastResort) {
            const [lastResort] = await firstValueFrom(this.mlsService.generateAdditionalKeyPackages(handle, 1));
            if (lastResort) upload.push({keyPackage: lastResort.keyPackage, isLastResort: true});
        }

        return upload;
    }
}
