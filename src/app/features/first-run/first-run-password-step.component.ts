import {ChangeDetectionStrategy, Component, input, output, signal} from '@angular/core';
import {PasswordDirective} from 'primeng/password';
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-first-run-password-step',
    imports: [PasswordDirective, TranslateModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="flex flex-col gap-4">
            <div class="flex flex-col gap-2">
                <h2 class="m-0 text-lg font-semibold text-text-primary">
                    {{ 'FIRST_RUN.PASSWORD.TITLE' | translate }}
                </h2>
                <p class="m-0 text-sm leading-relaxed text-text-secondary">
                    {{ 'FIRST_RUN.PASSWORD.SUBTITLE' | translate }}
                </p>
            </div>

            <div class="flex flex-col gap-1.5">
                <label class="text-xs font-medium text-text-secondary" for="first-run-password">
                    {{ 'FIRST_RUN.PASSWORD.LABEL' | translate }}
                </label>
                <!-- pPassword takes [disabled] as its own input and never puts it on the element, so the attribute does the disabling. -->
                <input
                    (input)="onInput($event)"
                    (keydown.enter)="submit()"
                    [attr.disabled]="busy() ? '' : null"
                    [disabled]="busy()"
                    [feedback]="false"
                    [placeholder]="'FIRST_RUN.PASSWORD.PLACEHOLDER' | translate"
                    [value]="password()"
                    autocomplete="current-password"
                    class="w-full"
                    data-testid="first-run-password"
                    id="first-run-password"
                    pPassword
                    type="password"
                />
            </div>

            @if (error()) {
                <p class="m-0 flex items-center text-xs text-offline" data-testid="first-run-password-error">
                    <i class="pi pi-exclamation-circle mr-1.5"></i>{{ error()! | translate }}
                </p>
            }
        </div>
    `,
})
export class FirstRunPasswordStepComponent {
    readonly error = input<string | null>(null);
    readonly busy = input(false);
    readonly submitted = output<string>();

    protected readonly password = signal('');

    /** Called by the shell's footer button as well as by Enter in the field. */
    submit(): void {
        const typed = this.password();
        if (!typed) return;
        this.submitted.emit(typed);
    }

    protected onInput(event: Event): void {
        this.password.set((event.target as HTMLInputElement).value);
    }
}
