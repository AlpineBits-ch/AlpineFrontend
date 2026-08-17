import {inject, Injectable, signal} from '@angular/core';
import {HttpClient, HttpErrorResponse} from '@angular/common/http';
import {environment} from '../../environments/environment';
import {catchError, finalize, firstValueFrom, from, map, Observable, of, shareReplay, tap} from 'rxjs';
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

    /**
     * The `self` request already on the wire, shared by whoever asks while it is.
     *
     * <p>Written before anything subscribes and cleared when the request settles, so this is a
     * coalescing window rather than a second cache.</p>
     */
    private inFlightSelf: Observable<UserDto> | null = null;

    /**
     * The authenticated account, always from the server.
     *
     * <p>Called from roughly eight places, several of which run during the same launch - the main
     * page asks twice on its own - and this is the largest payload identity serves, carrying the
     * master-key envelope and the device list. Concurrent callers therefore share one request.</p>
     *
     * <p><b>Coalescing only, deliberately not cache-first.</b> The settings screens call this
     * precisely because they want the live row, so answering a later caller from {@link self} would
     * silently stop them ever showing a change made on another device, and would defeat the
     * `deleteAccount` / `cancelDeletion` refetches that exist to pick up the new status. Callers
     * that overlap share; a caller that arrives after the request settled gets a real refetch.</p>
     */
    getSelf(): Observable<UserDto> {
        const existing = this.inFlightSelf;
        if (existing) return existing;

        const shared = this.requestSelf().pipe(
            finalize(() => this.inFlightSelf = null),
            shareReplay({bufferSize: 1, refCount: false}),
        );
        this.inFlightSelf = shared;
        return shared;
    }

    /**
     * One uncoalesced `self` request.
     *
     * <p>Used by the read-after-write callers. `deleteAccount` and `cancelDeletion` refetch because
     * their own responses carry no user body, and joining a request that was already on the wire
     * before the write landed would hand them the previous status - the account still shown as
     * Active immediately after the user asked to delete it, which is the one moment that screen has
     * to be right.</p>
     */
    private requestSelf(): Observable<UserDto> {
        return this.httpClient
            .get<UserDto>(`${this.apiConfig.baseUrl()}/api/v1/identity/users/self`)
            .pipe(tap(user => this.self.set(user)));
    }

    /**
     * Records or replaces the account's own phone number.
     *
     * <p><b>The signal is patched from the server's echo, not from the value sent.</b> The server
     * normalises - it strips the separators a contact card carries - so what it stores can differ
     * from what was typed, and showing the typed form back would put a number on screen that is not
     * the one a housemate will be given. The same rule the sharing toggle follows, for the same
     * reason.</p>
     *
     * <p>Errors are left to the caller. A `400` here is a format the client should have caught
     * first (see `checkE164`), so it means the two rules have drifted, and swallowing it would hide
     * exactly the case worth knowing about.</p>
     */
    setPhoneNumber(phoneNumber: string): Observable<string> {
        return this.httpClient.put<{ phoneNumber: string }>(
            `${this.apiConfig.baseUrl()}/api/v1/identity/users/self/phone`,
            {phoneNumber}
        ).pipe(
            map(response => response.phoneNumber),
            tap(stored => this.patchSelf({phoneNumber: stored})),
        );
    }

    /**
     * Removes the account's own phone number.
     *
     * <p>Idempotent server-side: it answers the same way whether there was a number or not, which is
     * the state the caller asked for either way.</p>
     *
     * <p><b>This does not clear any household's sharing opt-in</b>, and it does not need to. Guild
     * only ever hands out a number Identity gave it, so an opt-in with nothing behind it produces
     * exactly the same response as no opt-in at all - a housemate sees nothing, and cannot tell
     * which of the two it was. That indistinguishability is a guarantee of the read path rather than
     * something this call has to tidy up.</p>
     */
    removePhoneNumber(): Observable<void> {
        return this.httpClient.delete<void>(
            `${this.apiConfig.baseUrl()}/api/v1/identity/users/self/phone`
        ).pipe(
            tap(() => this.patchSelf({phoneNumber: null})),
        );
    }

    /**
     * Applies a field change to the cached self, or does nothing when there is no cached self.
     *
     * <p>Deliberately not a refetch. `GET /users/self` is a large payload carrying the master-key
     * envelope and the device list, and re-pulling all of it because one string changed would also
     * race any in-flight edit on another field.</p>
     */
    private patchSelf(patch: Partial<UserDto>): void {
        this.self.update(current => current ? {...current, ...patch} : current);
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
            switchMap(() => this.requestSelf())
        );
    }

    cancelDeletion(): Observable<UserDto> {
        return this.httpClient.post<void>(
            `${this.apiConfig.baseUrl()}/api/v1/identity/users/self/cancel-deletion`,
            {}
        ).pipe(
            switchMap(() => this.requestSelf())
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
