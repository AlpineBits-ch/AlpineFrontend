import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {
    AutoModConfig,
    MemberPrompt,
    OnboardingConfig,
    OnboardingResponse,
    OnboardingStatus,
    PendingMember,
    WelcomeScreen,
} from '../dtos/response/guild-safety.dto';

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

    /**
     * Idempotent - accepting twice is a no-op, not an error, and the second call does
     * not re-apply responses. A JSON body is mandatory even with no prompts: an entirely
     * empty request is rejected by the model binder before the endpoint runs.
     */
    acceptOnboarding(guildId: string, responses: OnboardingResponse[] = []): Observable<void> {
        return this.http.post<void>(`${this.base}/guilds/${guildId}/onboarding/accept`, {responses});
    }

    /** Every prompt (including inOnboarding: false ones) with the member's picks marked. */
    getMyPrompts(guildId: string): Observable<MemberPrompt[]> {
        return this.http.get<MemberPrompt[]>(`${this.base}/guilds/${guildId}/onboarding/prompts`);
    }

    /**
     * Full replace across all prompts, not a delta - an omitted prompt is treated as
     * "nothing selected" and its grants are revoked.
     */
    setMyResponses(guildId: string, responses: OnboardingResponse[]): Observable<void> {
        return this.http.put<void>(`${this.base}/guilds/${guildId}/onboarding/me/responses`, {responses});
    }

    // ── Welcome screen ───────────────────────────────────────────────────────
    getWelcomeScreen(guildId: string): Observable<WelcomeScreen> {
        return this.http.get<WelcomeScreen>(`${this.base}/guilds/${guildId}/welcome-screen`);
    }

    updateWelcomeScreen(guildId: string, screen: WelcomeScreen): Observable<WelcomeScreen> {
        return this.http.put<WelcomeScreen>(`${this.base}/guilds/${guildId}/welcome-screen`, screen);
    }

    // ── Moderation ───────────────────────────────────────────────────────────
    /** Members still sitting on the rules screen. Needs ModerateMembers or ManageGuild. */
    getPendingMembers(guildId: string, limit = 100, offset = 0): Observable<PendingMember[]> {
        return this.http.get<PendingMember[]>(
            `${this.base}/guilds/${guildId}/members/pending?limit=${limit}&offset=${offset}`);
    }
}
