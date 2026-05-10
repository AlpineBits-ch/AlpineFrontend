import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';
import {catchError, from, map, Observable, of} from 'rxjs';
import { EncryptedMasterKey, UserDto } from '../dtos/response/UserDto';
import {MlsService} from "./mls.service";
import {switchMap} from "rxjs/operators";

@Injectable({ providedIn: 'root' })
export class UserService {
  private httpClient = inject(HttpClient);
  private  mlsService = inject(MlsService);

  getSelf(): Observable<UserDto> {
    return this.httpClient.get<UserDto>(`${environment.apiUrl}/api/v1/identity/users/self`);
  }

  verifyPassword(password: string): Observable<boolean> {
    return this.httpClient.post<unknown>(
      `${environment.apiUrl}/api/v1/identity/authentication/verify`,
      { password }
    ).pipe(
      map(() => true),
      catchError(() => of(false))
    );
  }

  uploadEncryptedMasterKey(_payload: EncryptedMasterKey): Observable<void> {

    return this.httpClient.post<void>(
      `${environment.apiUrl}/api/v1/identity/users/master`,
      _payload
    );

  }

  getToGenerateKeyCount(): Observable<{ count: number }> {


    return from(this.mlsService.getOrCreateDeviceIdentifier()).pipe(
        switchMap(deviceId => {
          return this.httpClient.get<{ count:number }>(`${environment.apiUrl}/api/v1/identity/devices/client/${deviceId}/generate`
          )
        })
    )
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
                        keyPackages: packages.map(p => ({ keyPackage: p.keyPackage }))
                      };

                      // 4. Use the deviceId in your URL or body
                      return this.httpClient.post<void>(
                          `${environment.apiUrl}/api/v1/identity/devices/client/${deviceId}/key-packages`,
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
