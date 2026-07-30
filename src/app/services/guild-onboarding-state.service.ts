import {inject, Injectable, signal} from '@angular/core';
import {TranslateService} from '@ngx-translate/core';
import {GuildSafetyService} from './guild-safety.service';
import {ToastService} from './toast.service';
import {OnboardingResponse, OnboardingStatus} from '../dtos/response/guild-safety.dto';

/** What a failed status read falls back to: no onboarding, nothing gated. */
const NOT_GATED: OnboardingStatus = {enabled: false, completed: true, defaultChannelIds: [], prompts: []};

/**
 * Caches each guild's onboarding status for the current member. Onboarding is a
 * one-way gate - once accepted it never re-arms - so a single fetch per guild per
 * session is enough and re-fetching on every guild open would be pure noise.
 */
@Injectable({providedIn: 'root'})
export class GuildOnboardingStateService {
    private readonly statuses = signal<Record<string, OnboardingStatus>>({});
    private readonly requested = new Set<string>();
    private readonly accepting = signal(false);
    private safety = inject(GuildSafetyService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    statusFor(guildId: string): OnboardingStatus | undefined {
        return this.statuses()[guildId];
    }

    isAccepting(): boolean {
        return this.accepting();
    }

    /**
     * Gated on `enabled`, not just `completed`. A member who joined while onboarding was
     * on and had it turned off under them keeps `completed: false` forever but is not
     * restricted - keying off `completed` alone strands them on an empty rules screen.
     *
     * `enabled` only exists on the post-parity payload. Against a server still returning
     * the v1 shape the field is absent, and treating that as "disabled" would silently
     * drop the rules gate entirely - so fall back to "is there anything to show".
     */
    pendingForGuild(guildId: string): boolean {
        const status = this.statuses()[guildId];
        if (!status || status.completed) return false;

        const enabled = status.enabled ?? (!!status.rulesText || (status.prompts?.length ?? 0) > 0);
        return enabled;
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
                this.statuses.update(m => ({...m, [guildId]: NOT_GATED}));
            },
        });
    }

    /**
     * `onDone` fires only on success. Roles and channel access change here, so callers
     * use it to re-fetch the guild - the local channel list is stale the moment this
     * resolves.
     */
    accept(guildId: string, responses: OnboardingResponse[] = [], onDone?: () => void): void {
        if (this.accepting()) return;
        this.accepting.set(true);

        this.safety.acceptOnboarding(guildId, responses).subscribe({
            next: () => {
                this.accepting.set(false);
                this.statuses.update(m => ({
                    ...m,
                    [guildId]: {...(m[guildId] ?? NOT_GATED), completed: true},
                }));
                onDone?.();
            },
            error: err => {
                // Leave the cached status untouched on failure - the guild stays pending
                // and the accept button is never disabled, so the user can just retry.
                // Surface the failure here (not in the wizard) since this is where the
                // request and its outcome both live.
                this.accepting.set(false);
                this.toast.httpError(this.translate.instant('ONBOARDING_GATE.ACCEPT_ERROR'), err);
            },
        });
    }
}
