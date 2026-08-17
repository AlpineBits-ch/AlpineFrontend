import {inject, Injectable, signal} from '@angular/core';
import {TranslateService} from '@ngx-translate/core';
import {GuildSafetyService} from './guild-safety.service';
import {ToastService} from './toast.service';
import {OnboardingResponse, OnboardingStatus} from '../dtos/response/guild-safety.dto';

/** What a failed status read falls back to: no onboarding, nothing gated. */
const NOT_GATED: OnboardingStatus = {enabled: false, completed: true, defaultChannelIds: [], prompts: []};

/** Caches each guild's onboarding status for the current member. Onboarding is a one-way gate, so one fetch per guild per session is enough. */
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
     * Gated on `enabled`, not just `completed`: a member whose onboarding was turned off under them keeps `completed: false` forever and must not be stranded.
     * `enabled` is absent on the v1 payload, and reading that as "disabled" would silently drop the rules gate, so fall back to "is there anything to show".
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
                // A failed status read must not gate the UI: the server is the real enforcement point.
                this.statuses.update(m => ({...m, [guildId]: NOT_GATED}));
            },
        });
    }

    /** `onDone` fires only on success. Roles and channel access change here, so the local channel list is stale the moment this resolves. */
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
                // Cached status left untouched on failure, so the guild stays pending and retry works.
                this.accepting.set(false);
                this.toast.httpError(this.translate.instant('ONBOARDING_GATE.ACCEPT_ERROR'), err);
            },
        });
    }
}
