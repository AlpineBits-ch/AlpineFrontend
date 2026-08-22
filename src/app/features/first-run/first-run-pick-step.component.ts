import {ChangeDetectionStrategy, Component, input, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {UserInterest} from '../../dtos/response/UserDto';

interface Choice {
    interest: UserInterest;
    icon: string;
    titleKey: string;
    taglineKey: string;
    noteKey: string;
}

/** The two interest cards of the "what did you come here for" picker. Purely controlled: a click emits and the host holds the answer, so the same cards serve first run and the settings screen. */
@Component({
    selector: 'app-first-run-pick-step',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule],
    template: `
        <div class="grid gap-4 sm:grid-cols-2">
            @for (choice of choices; track choice.interest) {
                <button
                    (click)="toggled.emit(choice.interest)"
                    [attr.aria-pressed]="isSelected(choice.interest)"
                    [attr.data-interest]="choice.interest"
                    data-testid="onboarding-choice"
                    [class]="
                        isSelected(choice.interest)
                            ? 'border-brand bg-[color-mix(in_srgb,var(--color-brand)_10%,transparent)]'
                            : 'border-border bg-card hover:bg-hover'
                    "
                    class="relative flex flex-col gap-3 rounded-2xl border p-5 text-left transition-colors"
                    type="button"
                >
                    <span
                        [class]="
                            isSelected(choice.interest)
                                ? 'border-brand bg-brand text-white'
                                : 'border-border text-transparent'
                        "
                        class="absolute right-4 top-4 grid h-5 w-5 place-items-center rounded-full border transition-colors"
                    >
                        <i class="pi pi-check text-[0.625rem]"></i>
                    </span>

                    <span
                        class="grid h-11 w-11 place-items-center rounded-xl bg-[color-mix(in_srgb,var(--color-brand)_14%,transparent)]"
                    >
                        <i [class]="'pi ' + choice.icon" class="text-lg text-brand-dim"></i>
                    </span>

                    <span class="text-base font-semibold text-text-primary">
                        {{ choice.titleKey | translate }}
                    </span>
                    <span class="text-sm leading-snug text-text-secondary">
                        {{ choice.taglineKey | translate }}
                    </span>
                    <span class="mt-auto pt-1 text-xs text-text-muted">
                        {{ choice.noteKey | translate }}
                    </span>
                </button>
            }
        </div>
    `,
})
export class FirstRunPickStepComponent {
    readonly selected = input.required<UserInterest[]>();

    readonly toggled = output<UserInterest>();

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

    protected isSelected(interest: UserInterest): boolean {
        return this.selected().includes(interest);
    }
}
