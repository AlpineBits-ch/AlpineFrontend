import {ChangeDetectionStrategy, Component, computed, inject, signal, viewChild} from '@angular/core';
import {Button} from 'primeng/button';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {firstValueFrom} from 'rxjs';
import {FirstRunService} from '../../services/first-run.service';
import {FirstRunStep} from '../../services/first-run-steps';
import {OnboardingService} from '../../services/onboarding.service';
import {MasterKeySetupService} from '../../services/master-key-setup.service';
import {DeviceRegistrationService} from '../../services/device-registration.service';
import {SignupPasswordHolder} from '../../services/signup-password-holder';
import {resolveDeviceName} from '../../services/device-description';
import {OsInfo} from '../../platform/ports/os-info.port';
import {UserInterest} from '../../dtos/response/UserDto';
import {FirstRunPickStepComponent} from './first-run-pick-step.component';
import {FirstRunPasswordStepComponent} from './first-run-password-step.component';
import {FirstRunCodeStepComponent} from './first-run-code-step.component';

function randomWordIndex(code: string): number {
    const words = code.split(/\s+/).filter(Boolean);
    if (words.length === 0) return 0;
    return Math.floor(Math.random() * words.length);
}

/**
 * The one takeover a new account walks: the interest picker, the password this device still owes,
 * and the recovery code. Which of the three appear is snapshotted by {@link FirstRunService}.
 */
@Component({
    selector: 'app-first-run',
    imports: [
        Button,
        TranslateModule,
        FirstRunPickStepComponent,
        FirstRunPasswordStepComponent,
        FirstRunCodeStepComponent,
    ],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div
            class="fixed inset-0 z-[1200] bg-app-bg flex flex-col"
            data-testid="onboarding"
            style="padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom)"
        >
            <!-- The overlay covers the titlebar, so it carries its own drag region or the window
                 cannot be moved for as long as first run is up. Matches .titlebar's height. -->
            <div class="shrink-0 h-titlebar" data-tauri-drag-region></div>

            <div class="flex-1 min-h-0 overflow-y-auto thin-scrollbar px-6 pb-8">
                <div class="mx-auto flex max-w-3xl flex-col gap-8 pt-6">
                    @if (steps().length > 1) {
                        <div class="flex flex-col gap-2" data-testid="first-run-rail">
                            <p class="m-0 text-xs font-medium text-text-muted">
                                {{
                                    'FIRST_RUN.STEP' | translate: {current: position(), total: steps().length}
                                }}
                            </p>
                            <div class="flex gap-1.5">
                                @for (owed of steps(); track $index) {
                                    <span
                                        [class]="$index <= index() ? 'bg-brand' : 'bg-border'"
                                        class="h-1 flex-1 rounded-full transition-colors"
                                    ></span>
                                }
                            </div>
                        </div>
                    }

                    @switch (step()) {
                        @case ('pick') {
                            <div class="flex flex-col items-center gap-3 text-center">
                                <div
                                    class="grid h-14 w-14 place-items-center rounded-2xl bg-[color-mix(in_srgb,var(--color-brand)_18%,transparent)]"
                                >
                                    <i class="pi pi-sparkles text-xl text-brand-dim"></i>
                                </div>
                                <h1 class="m-0 text-2xl font-semibold text-text-primary">
                                    {{ 'ACCOUNT_ONBOARDING.TITLE' | translate }}
                                </h1>
                                <p class="m-0 max-w-md text-sm text-text-secondary">
                                    {{ 'ACCOUNT_ONBOARDING.SUBTITLE' | translate }}
                                </p>
                            </div>

                            <app-first-run-pick-step (toggled)="toggle($event)" [selected]="selected()" />

                            <p class="m-0 text-center text-xs text-text-muted">
                                {{ 'ACCOUNT_ONBOARDING.CHANGE_LATER' | translate }}
                            </p>

                            @if (submitError()) {
                                <p
                                    class="m-0 text-center text-sm text-offline"
                                    data-testid="first-run-submit-error"
                                >
                                    {{ 'ACCOUNT_ONBOARDING.SUBMIT_ERROR' | translate }}
                                </p>
                            }
                        }

                        @case ('password') {
                            <app-first-run-password-step
                                (submitted)="onPassword($event)"
                                [busy]="busy()"
                                [error]="passwordError()"
                            />
                        }

                        @case ('recovery-code') {
                            @if (code()) {
                                <app-first-run-code-step
                                    (confirmed)="confirmed.set(true)"
                                    [code]="code()"
                                    [error]="codeError()"
                                    [wordIndex]="wordIndex()"
                                />
                            } @else if (codeError()) {
                                <p class="m-0 text-sm text-offline" data-testid="first-run-code-failed">
                                    <i class="pi pi-exclamation-circle mr-1.5"></i>{{ codeError() }}
                                </p>
                            }
                        }
                    }
                </div>
            </div>

            <div class="shrink-0 border-t border-border-subtle px-6 py-4">
                <div class="mx-auto flex max-w-3xl items-center justify-end">
                    <p-button
                        (onClick)="advance()"
                        [disabled]="!canAdvance()"
                        [label]="advanceLabel() | translate"
                        data-testid="first-run-continue"
                        icon="pi pi-arrow-right"
                        iconPos="right"
                        size="small"
                    />
                </div>
            </div>
        </div>
    `,
})
export class FirstRunComponent {
    private readonly firstRun = inject(FirstRunService);
    private readonly onboarding = inject(OnboardingService);
    private readonly setup = inject(MasterKeySetupService);
    private readonly devices = inject(DeviceRegistrationService);
    private readonly heldPassword = inject(SignupPasswordHolder);
    private readonly os = inject(OsInfo);
    private readonly translate = inject(TranslateService);

    protected readonly steps = this.firstRun.steps;
    protected readonly index = signal(0);
    protected readonly step = computed<FirstRunStep | null>(() => this.steps()[this.index()] ?? null);
    protected readonly position = computed(() => this.index() + 1);

    protected readonly selected = signal<UserInterest[]>([]);
    protected readonly busy = signal(false);
    protected readonly submitError = signal(false);
    protected readonly passwordError = signal<string | null>(null);

    protected readonly code = signal('');
    protected readonly wordIndex = signal(0);
    protected readonly codeError = signal<string | null>(null);
    protected readonly confirmed = signal(false);
    protected readonly written = signal(false);

    private readonly passwordStep = viewChild(FirstRunPasswordStepComponent);

    /** Never a signal: nothing should reactively read a password. */
    private password: string | null = null;

    protected readonly canAdvance = computed(() => {
        if (this.busy()) return false;
        switch (this.step()) {
            case 'pick':
                return this.selected().length > 0;
            case 'password':
                return true;
            case 'recovery-code':
                return !!this.codeError() || (this.confirmed() && this.written());
            default:
                return false;
        }
    });

    protected readonly advanceLabel = computed(() => {
        if (this.step() === 'recovery-code' && this.codeError()) return 'COMMON.RETRY';
        return this.position() >= this.steps().length ? 'FIRST_RUN.FINISH' : 'COMMON.CONTINUE';
    });

    constructor() {
        void this.registerDevice();
        this.enter(this.step());
    }

    protected toggle(interest: UserInterest): void {
        this.selected.update(current =>
            current.includes(interest) ? current.filter(other => other !== interest) : [...current, interest],
        );
    }

    protected async advance(): Promise<void> {
        if (!this.canAdvance()) return;
        switch (this.step()) {
            case 'pick':
                await this.submitPick();
                return;
            case 'password':
                this.submitPassword();
                return;
            case 'recovery-code':
                this.finishCode();
                return;
        }
    }

    protected async onPassword(password: string): Promise<void> {
        this.passwordError.set(null);
        this.busy.set(true);
        try {
            if (!(await this.setup.verifyPassword(password))) {
                this.passwordError.set('FIRST_RUN.PASSWORD.WRONG');
                return;
            }
        } catch (err) {
            console.error('Could not check the account password', err);
            this.passwordError.set('FIRST_RUN.PASSWORD.WRONG');
            return;
        } finally {
            this.busy.set(false);
        }

        this.password = password;
        this.next();
    }

    /** Nothing waits on this: a device that could not register is covered by main-page's strip. */
    private async registerDevice(): Promise<void> {
        try {
            const name = await resolveDeviceName(this.os);
            await firstValueFrom(this.devices.register(name));
        } catch (err) {
            console.error('Could not register this device during first run', err);
        }
    }

    private async submitPick(): Promise<void> {
        this.busy.set(true);
        this.submitError.set(false);
        try {
            await this.onboarding.submit(this.selected());
        } catch {
            this.submitError.set(true);
            return;
        } finally {
            this.busy.set(false);
        }

        // The answer decides the tail: an account that did not take the messaging half owes no key.
        if (!this.onboarding.wantsSocial()) {
            this.finish();
            return;
        }
        this.next();
    }

    private submitPassword(): void {
        // The step emits synchronously when the field has content, and that clears this.
        this.passwordError.set('FIRST_RUN.PASSWORD.REQUIRED');
        this.passwordStep()?.submit();
    }

    private finishCode(): void {
        if (this.codeError()) {
            this.retryCode();
            return;
        }
        this.finish();
    }

    private retryCode(): void {
        this.codeError.set(null);
        // A code that was never shown can be minted again; one the user has written down cannot.
        if (!this.code()) {
            void this.showCode();
            return;
        }
        this.write();
    }

    private next(): void {
        const next = this.index() + 1;
        if (next >= this.steps().length) {
            this.finish();
            return;
        }
        this.index.set(next);
        this.enter(this.steps()[next]);
    }

    private enter(step: FirstRunStep | null): void {
        if (step === 'recovery-code') void this.showCode();
    }

    private async showCode(): Promise<void> {
        this.busy.set(true);
        try {
            const code = await this.setup.generateRecoveryCode();
            this.code.set(code);
            this.wordIndex.set(randomWordIndex(code));
        } catch (err) {
            this.codeError.set(this.setupFailed(err));
            return;
        } finally {
            this.busy.set(false);
        }

        this.write();
    }

    /** Runs while the code is on screen, so the confirm is the only thing left to wait for. */
    private write(): void {
        this.password ??= this.heldPassword.take();
        const password = this.password;
        if (!password) {
            this.codeError.set(this.setupFailed(new Error('No password held for master-key setup')));
            return;
        }

        this.written.set(false);
        this.codeError.set(null);
        void this.setup
            .run(password)
            .then(() => this.written.set(true))
            .catch((err: unknown) => this.codeError.set(this.setupFailed(err)));
    }

    /**
     * The lead has to stay: someone who has written the code down needs telling it still works.
     * A refusal detail goes after it, and nothing goes after it when there is no detail to add.
     */
    private setupFailed(err: unknown): string {
        const lead = this.translate.instant('FIRST_RUN.CODE.SETUP_FAILED') as string;
        const detail = this.setup.describeFailure(err);
        return detail ? `${lead} ${detail}` : lead;
    }

    private finish(): void {
        this.heldPassword.take();
        this.password = null;
        this.firstRun.complete();
    }
}
