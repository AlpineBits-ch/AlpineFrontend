import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {UserDeviceDto} from '../dtos/response/user-device.dto';
import {RegisterDeviceDto} from '../dtos/request/register-device.dto';
import {ApiConfigService} from "./api-config.service";

@Injectable({providedIn: 'root'})
export class DeviceService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);
    private readonly base = `${this.apiConfig.baseUrl()}/api/v1/identity/devices`;

    getMyDevices(): Observable<UserDeviceDto[]> {
        return this.http.get<UserDeviceDto[]>(this.base);
    }

    registerDevice(dto: RegisterDeviceDto): Observable<UserDeviceDto> {
        return this.http.post<UserDeviceDto>(this.base, dto);
    }

    /**
     * Removes the device and, by cascade, its MLS key packages, its encrypted backup and its
     * push tokens; login sessions from that device are revoked. There was no removal path
     * before this, which is why a reinstalled handset kept receiving push forever.
     */
    deleteDevice(clientDeviceId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/client/${encodeURIComponent(clientDeviceId)}`);
    }
}
