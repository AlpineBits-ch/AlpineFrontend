import {Component, computed, inject, signal} from '@angular/core';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {Select} from 'primeng/select';
import {FormsModule} from '@angular/forms';
import {TranslateModule} from '@ngx-translate/core';
import {UserSettingsService} from '../../../../../services/user-settings.service';
import {AppInfoService} from '../../../../../services/app-info.service';
import {UserService} from '../../../../../services/user.service';
import {OnboardingService} from '../../../../../services/onboarding.service';
import {SocialKeyGateService} from '../../../../../services/social-key-gate.service';
import {UserInterest} from '../../../../../dtos/response/UserDto';

@Component({
    selector: 'app-other-settings',
    imports: [ToggleSwitch, Select, FormsModule, TranslateModule],
    templateUrl: './other-settings.component.html',
    styleUrl: './other-settings.component.css',
})
export class OtherSettingsComponent {
    selectedLanguage = 'en-us';
    public readonly languages = [
        {label: 'English (US)', value: 'en-us'},
    ];
    public readonly systemToggles = [
        {label: 'Minimize to tray', desc: 'Keep Alpine running in the system tray when closed.'},
        {label: 'Run in background', desc: 'Continue receiving notifications when minimized.'},
    ];
    public readonly advancedToggles = [
        {label: 'Hardware acceleration', desc: 'Use GPU rendering for smoother performance.'},
        {label: 'Developer mode', desc: 'Show additional debug information and tools.'},
    ];
    public readonly interestChoices = [
        {
            interest: UserInterest.Isle,
            titleKey: 'ACCOUNT_ONBOARDING.ISLE_TITLE',
            taglineKey: 'ACCOUNT_ONBOARDING.ISLE_TAGLINE',
        },
        {
            interest: UserInterest.Social,
            titleKey: 'ACCOUNT_ONBOARDING.SOCIAL_TITLE',
            taglineKey: 'ACCOUNT_ONBOARDING.SOCIAL_TAGLINE',
        },
    ];
    protected readonly userSettings = inject(UserSettingsService);
    protected readonly appInfo = inject(AppInfoService);
    private readonly userService = inject(UserService);
    private readonly onboarding = inject(OnboardingService);
    private readonly socialGate = inject(SocialKeyGateService);

    protected readonly savingInterests = signal(false);

    private readonly interests = computed(() => this.userService.self()?.interests ?? []);

    protected hasInterest(interest: UserInterest): boolean {
        return this.interests().includes(interest);
    }

    /**
     * Turning Venta Chat on here runs key setup immediately rather than deferring it, because
     * unlike the gated call sites there is no action waiting behind this switch - deferring would
     * mean the toggle appears to do nothing at all.
     *
     * <p>The last interest cannot be turned off: an account that wants neither half is a state the
     * launch sequence has no answer for, and the honest way to leave is to delete the account.</p>
     */
    protected toggleInterest(interest: UserInterest, enabled: boolean): void {
        if (this.savingInterests()) return;

        const current = this.interests();
        const next = enabled
            ? [...new Set([...current, interest])]
            : current.filter(i => i !== interest);
        if (next.length === 0) return;

        this.savingInterests.set(true);
        void this.onboarding.submit(next)
            .then(() => {
                if (enabled && interest === UserInterest.Social && !this.socialGate.isSatisfied()) {
                    this.socialGate.promptNow();
                }
            })
            .catch(err => console.error('Could not update the account interests', err))
            .finally(() => this.savingInterests.set(false));
    }
}
