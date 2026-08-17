import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';

export enum FederationStatus {
    Pending = 'Pending',
    Active = 'Active',
    Blocked = 'Blocked',
    Defederated = 'Defederated',
}

export enum AcceptancePolicy {
    AutoAccept = 'AutoAccept',
    RequireApproval = 'RequireApproval',
}

export interface FederationInstance {
    id: string;
    host: string;
    name: string;
    status: FederationStatus;
    createdAt: string;
    updatedAt: string;
}

export interface FederationSettings {
    acceptancePolicy: AcceptancePolicy;
}

export interface HandshakeResponse {
    host: string;
    name: string;
    protocolVersion: string;
    publicKey: string;
    status: 'accepted' | 'pending';
}

@Injectable({providedIn: 'root'})
export class AdminFederationService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    private get base(): string {
        return `${this.apiConfig.baseUrl()}/api/v1/admin/federation`;
    }

    getInstances(status?: FederationStatus): Observable<FederationInstance[]> {
        const url = status
            ? `${this.base}/instances?status=${status}`
            : `${this.base}/instances`;
        return this.http.get<FederationInstance[]>(url);
    }

    approveInstance(instanceId: string): Observable<void> {
        return this.http.post<void>(`${this.base}/${instanceId}/approve`, null);
    }

    denyInstance(instanceId: string): Observable<void> {
        return this.http.post<void>(`${this.base}/${instanceId}/deny`, null);
    }

    defederateInstance(instanceId: string, reason?: string): Observable<void> {
        return this.http.post<void>(`${this.base}/${instanceId}/defederate`, {reason: reason ?? ''});
    }

    getSettings(): Observable<FederationSettings> {
        return this.http.get<FederationSettings>(`${this.base}/settings`);
    }

    updateSettings(acceptancePolicy: AcceptancePolicy): Observable<FederationSettings> {
        return this.http.patch<FederationSettings>(`${this.base}/settings`, {acceptancePolicy});
    }

    initiateHandshake(targetHost: string): Observable<HandshakeResponse> {
        return this.http.post<HandshakeResponse>(`${this.base}/initiate`, {targetHost});
    }
}
