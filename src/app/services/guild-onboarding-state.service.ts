import {inject, Injectable, signal} from '@angular/core';
import {GuildSafetyService} from './guild-safety.service';
import {OnboardingStatus} from '../dtos/response/guild-safety.dto';

/**
 * Caches each guild's onboarding status for the current member. Onboarding is a
 * one-way gate - once accepted it never re-arms - so a single fetch per guild per
 * session is enough and re-fetching on every guild open would be pure noise.
 */
@Injectable({providedIn: 'root'})
export class GuildOnboardingStateService {
    private readonly statuses = signal<Record<string, OnboardingStatus>>({});
    private readonly requested = new Set<string>();
    private safety = inject(GuildSafetyService);

    statusFor(guildId: string): OnboardingStatus | undefined {
        return this.statuses()[guildId];
    }

    pendingForGuild(guildId: string): boolean {
        return this.statuses()[guildId]?.completed === false;
    }

    loadFor(guildId: string): void {
        if (this.requested.has(guildId)) return;
        this.requested.add(guildId);

        this.safety.getMyOnboarding(guildId).subscribe({
            next: status => this.statuses.update(m => ({...m, [guildId]: status})),
            error: () => {
                // A failed status read must not gate the UI: the server is the real
                // enforcement point, so the worst case of assuming "not pending" is a
                // send that comes back 403, not an unmoderated guild.
                this.statuses.update(m => ({...m, [guildId]: {completed: true, defaultChannelIds: []}}));
            },
        });
    }

    accept(guildId: string): void {
        this.safety.acceptOnboarding(guildId).subscribe({
            next: () => this.statuses.update(m => ({
                ...m,
                [guildId]: {...(m[guildId] ?? {defaultChannelIds: []}), completed: true},
            })),
        });
    }
}
