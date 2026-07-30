import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {AutoModConfig, OnboardingConfig, OnboardingStatus} from '../dtos/response/guild-safety.dto';

@Injectable({providedIn: 'root'})
export class GuildSafetyService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    // ── Auto-moderation ──────────────────────────────────────────────────────
    getAutoModConfig(guildId: string): Observable<AutoModConfig> {
        return this.http.get<AutoModConfig>(`${this.base}/guilds/${guildId}/automod`);
    }

    /** Full replace, not a patch - always send every field, including unchanged ones. */
    updateAutoModConfig(guildId: string, config: AutoModConfig): Observable<AutoModConfig> {
        return this.http.put<AutoModConfig>(`${this.base}/guilds/${guildId}/automod`, config);
    }

    // ── Onboarding ───────────────────────────────────────────────────────────
    getOnboardingConfig(guildId: string): Observable<OnboardingConfig> {
        return this.http.get<OnboardingConfig>(`${this.base}/guilds/${guildId}/onboarding`);
    }

    updateOnboardingConfig(guildId: string, config: OnboardingConfig): Observable<OnboardingConfig> {
        return this.http.put<OnboardingConfig>(`${this.base}/guilds/${guildId}/onboarding`, config);
    }

    getMyOnboarding(guildId: string): Observable<OnboardingStatus> {
        return this.http.get<OnboardingStatus>(`${this.base}/guilds/${guildId}/onboarding/me`);
    }

    /** Idempotent - accepting twice is a no-op, not an error. */
    acceptOnboarding(guildId: string): Observable<void> {
        return this.http.post<void>(`${this.base}/guilds/${guildId}/onboarding/accept`, {});
    }
}
