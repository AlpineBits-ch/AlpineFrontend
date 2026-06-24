import {inject, Injectable, signal} from '@angular/core';
import {HttpClient, HttpErrorResponse} from '@angular/common/http';
import {environment} from '../../environments/environment';
import {catchError, from, map, Observable, of, tap} from 'rxjs';
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

    getToGenerateKeyCount(): Observable<{ count: number }> {


        return from(this.mlsService.getOrCreateDeviceIdentifier()).pipe(
            switchMap(deviceId => {
                return this.httpClient.get<{
                    count: number
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

    deleteAccount(): Observable<void> {
        return this.httpClient.delete<void>(`${this.apiConfig.baseUrl()}/api/v1/identity/users/self`);
    }

    public replenishKeyCount(): Observable<void> {
        const handle = this.mlsService.keyHandle();

        if (!handle) {
            console.log('vault not unlocked, cannot replenish key count');
            return of(undefined);
        }

        // 1. Start with the device identifier
        return from(this.mlsService.getOrCreateDeviceIdentifier()).pipe(
            switchMap(deviceId => {
                // 2. Now that we have deviceId, get the count
                return this.getToGenerateKeyCount().pipe(
                    switchMap(response => {
                        // 3. Generate the packages using the handle and count
                        return from(this.mlsService.generateAdditionalKeyPackages(handle, response.count)).pipe(
                            switchMap(packages => {
                                const body = {
                                    keyPackages: packages.map(p => ({keyPackage: p.keyPackage}))
                                };

                                // 4. Use the deviceId in your URL or body
                                return this.httpClient.post<void>(
                                    `${this.apiConfig.baseUrl()}/api/v1/identity/devices/client/${deviceId}/key-packages`,
                                    body
                                );
                            })
                        );
                    })
                );
            })
        );
    }
}
