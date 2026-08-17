import {ChangeDetectionStrategy, Component, computed, inject, signal} from '@angular/core';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {OnboardingService} from '../../services/onboarding.service';
import {UserInterest} from '../../dtos/response/UserDto';

type Step = 'pick' | 'done';

interface Choice {
    interest: UserInterest;
    icon: string;
    titleKey: string;
    taglineKey: string;
    noteKey: string;
}

/**
 * The one-time "what did you come here for" picker, shown to a brand-new account after email
 * verification and before anything else.
 */
@Component({
    selector: 'app-account-onboarding',
    imports: [Button, TranslateModule],
    templateUrl: './account-onboarding.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountOnboardingComponent {
    protected state = inject(OnboardingService);

    protected readonly choices: Choice[] = [
        {
            interest: UserInterest.Isle,
            icon: 'pi-headphones',
            titleKey: 'ACCOUNT_ONBOARDING.ISLE_TITLE',
            taglineKey: 'ACCOUNT_ONBOARDING.ISLE_TAGLINE',
            noteKey: 'ACCOUNT_ONBOARDING.ISLE_NOTE',
        },
        {
            interest: UserInterest.Social,
            icon: 'pi-comments',
            titleKey: 'ACCOUNT_ONBOARDING.SOCIAL_TITLE',
            taglineKey: 'ACCOUNT_ONBOARDING.SOCIAL_TAGLINE',
            noteKey: 'ACCOUNT_ONBOARDING.SOCIAL_NOTE',
        },
    ];

    protected readonly step = signal<Step>('pick');
    protected readonly selected = signal<UserInterest[]>([]);

    protected readonly canContinue = computed(() => this.selected().length > 0);

    /** The confirmation step's body depends on whether key setup is about to run. */
    protected readonly pickedSocial = computed(() => this.selected().includes(UserInterest.Social));

    protected isSelected(interest: UserInterest): boolean {
        return this.selected().includes(interest);
    }

    protected toggle(interest: UserInterest): void {
        this.selected.update(current => current.includes(interest)
            ? current.filter(i => i !== interest)
            : [...current, interest]);
    }

    protected toDone(): void {
        if (!this.canContinue()) return;
        this.step.set('done');
    }

    protected back(): void {
        this.step.set('pick');
    }

    /**
     * Writes the answer. A failure leaves the wizard open with an error rather than closing:
     * this is the only thing standing between the account and a launch sequence that cannot decide
     * whether it owes a key-setup dialog.
     */
    protected finish(): void {
        void this.state.submit(this.selected()).catch(() => undefined);
    }
}
