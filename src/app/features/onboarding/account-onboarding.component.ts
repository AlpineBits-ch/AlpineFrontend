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
 *
 * <p>Venta is two products in one binary - proximity voice for The Isle, and an encrypted chat
 * client - and only the second needs a master key. Asking once, here, is what lets an account that
 * only wants the first skip a recovery-code ceremony it has no use for.</p>
 *
 * <p><b>It hides nothing.</b> Whatever is picked, every surface stays rendered and reachable; the
 * answer only decides whether master-key setup runs now or waits for the first social action. A
 * picker that quietly amputated half the app would be a worse product and a support burden, and
 * there is nothing here worth that.</p>
 *
 * <p>Non-dismissable, and submitted in one write at the end, following the guild join gate's
 * idiom: the endpoint has no partial-progress concept, so a per-step save would leave an account
 * both un-onboarded and partly answered.</p>
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

    protected step = signal<Step>('pick');
    protected selected = signal<UserInterest[]>([]);

    protected canContinue = computed(() => this.selected().length > 0);

    /** The confirmation step's body depends on whether key setup is about to run. */
    protected pickedSocial = computed(() => this.selected().includes(UserInterest.Social));

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
