import {computed, inject, Injectable, signal} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {firstValueFrom} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {UserService} from './user.service';
import {UserInterest} from '../dtos/response/UserDto';

interface OnboardingStateDto {
    onboardedAt: string;
    interests: UserInterest[];
}

/**
 * The account-level "what did you come here for" answer.
 *
 * <p>Venta is two products sharing a binary - proximity voice for The Isle, and an encrypted
 * chat client - and the two want different things from a new account. Only the second needs a
 * master key, so the answer collected here decides whether master-key setup runs at launch or is
 * deferred until the account actually reaches for something social (see
 * {@link SocialKeyGateService}).</p>
 *
 * <p>It changes nothing about what the app <i>shows</i>. Both halves stay fully rendered and
 * fully reachable for either answer; the only observable difference is the absence of a
 * key-setup dialog at first launch.</p>
 */
@Injectable({providedIn: 'root'})
export class OnboardingService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);
    private userService = inject(UserService);

    /** Drives the full-screen picker. Set by the launch sequence, cleared on submit. */
    readonly visible = signal(false);
    readonly submitting = signal(false);
    readonly error = signal(false);

    /**
     * Whether the picker is owed.
     *
     * <p>Absence of `onboardedAt` is read as *onboarded*, deliberately. The field is optional
     * because a self-hosted server on a build predating this feature sends neither it nor
     * {@link UserDto.interests}, and answering "true" there would gate every one of that server's
     * users behind a picker whose submit route 404s - a loop with no way out. An unloaded `self`
     * is treated the same way so nothing flashes mid-launch.</p>
     */
    readonly needsOnboarding = computed(() => {
        const user = this.userService.self();
        if (!user) return false;
        return 'onboardedAt' in user && !user.onboardedAt;
    });

    /**
     * Whether this account signed up for the messaging half, and so owes a master key.
     *
     * <p>Fails toward `true` for the same server-version reason as {@link needsOnboarding}: an
     * older server never sends `interests`, and its users have always had key setup at launch.
     * Reading a missing field as "Isle only" would silently stop writing master keys for an entire
     * deployment, and the symptom - history quietly unrecoverable after a reinstall - would not
     * surface for months.</p>
     */
    readonly wantsSocial = computed(() => {
        const interests = this.userService.self()?.interests;
        if (!interests) return true;
        return interests.includes(UserInterest.Social);
    });

    show(): void {
        this.error.set(false);
        this.visible.set(true);
    }

    async submit(interests: UserInterest[]): Promise<void> {
        // Guarded here as well as server-side: an empty answer is not a state any of the
        // downstream computeds can render sensibly.
        if (interests.length === 0) throw new Error('At least one interest must be selected.');

        this.submitting.set(true);
        this.error.set(false);
        try {
            const state = await firstValueFrom(this.http.put<OnboardingStateDto>(
                `${this.apiConfig.baseUrl()}/api/v1/identity/users/self/onboarding`,
                {interests},
            ));
            this.patchSelf(state);
            this.visible.set(false);
        } catch (err) {
            // Left visible and unpatched on purpose. The picker is the only thing standing between
            // this account and a launch sequence that cannot decide what to do, so a failed write
            // has to be retryable rather than dismissed into an inconsistent state.
            this.error.set(true);
            throw err;
        } finally {
            this.submitting.set(false);
        }
    }

    /**
     * Records that this account has taken up the messaging half after all.
     *
     * <p>Called once key setup completes through the deferred gate. Without it the stored answer
     * stays "Isle only" while the account now holds a master key, and every subsequent launch
     * reasons from a premise that stopped being true.</p>
     */
    async addSocialInterest(): Promise<void> {
        const current = this.userService.self()?.interests ?? [];
        if (current.includes(UserInterest.Social)) return;
        await this.submit([...current, UserInterest.Social]);
    }

    private patchSelf(state: OnboardingStateDto): void {
        const user = this.userService.self();
        if (!user) return;
        this.userService.self.set({
            ...user,
            onboardedAt: state.onboardedAt,
            interests: state.interests,
        });
    }
}
