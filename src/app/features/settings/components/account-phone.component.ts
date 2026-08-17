import {ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {take} from 'rxjs';
import {checkE164, e164ProblemKey} from '../../../models/e164-phone';
import {SettingsUiService} from '../../../services/settings-ui.service';
import {ToastService} from '../../../services/toast.service';
import {UserService} from '../../../services/user.service';

/** The account's own phone number: enter one, replace it, remove it. */
@Component({
    selector: 'app-account-phone',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [Button, InputText, FormsModule, TranslateModule],
    template: `
        <div class="flex flex-col gap-3" data-testid="account-phone">
            <div>
                <p class="text-sm text-text-primary">{{ 'ACCOUNT.PHONE.TITLE' | translate }}</p>
                <p class="text-xs text-text-muted mt-0.5">{{ 'ACCOUNT.PHONE.DESC' | translate }}</p>
            </div>

            @if (loading()) {
                <div class="h-9 w-full bg-white/[0.06] rounded animate-pulse"></div>
            } @else {
                <div class="flex flex-col gap-1.5">
                    <input
                        pInputText
                        class="w-full"
                        inputmode="tel"
                        autocomplete="tel"
                        [ngModel]="draft()"
                        (ngModelChange)="draft.set($event)"
                        [attr.aria-invalid]="!!problemKey()"
                        [attr.aria-label]="'ACCOUNT.PHONE.TITLE' | translate"
                        [placeholder]="'ACCOUNT.PHONE.PLACEHOLDER' | translate"
                    />

                    @if (problemKey(); as key) {
                        <p class="m-0 text-xs text-rose-300" data-testid="phone-problem">
                            {{ key | translate }}
                        </p>
                    } @else {
                        <!--
                          Shown while the box is right as well as while it is wrong: the "+" rule is
                          the thing people get wrong, and it is cheaper to state than to correct.
                        -->
                        <p class="m-0 text-xs text-text-muted">
                            {{ 'ACCOUNT.PHONE.FORMAT_HELP' | translate }}
                        </p>
                    }
                </div>

                <!--
                  The two sentences that keep this field honest. Neither is conditional: the
                  plaintext one is what somebody weighs before typing a number at all, and the
                  unchecked one is what stops the absence of a tick being read as the presence of
                  one.
                -->
                <p class="m-0 text-xs text-text-muted">{{ 'ACCOUNT.PHONE.PLAINTEXT' | translate }}</p>
                <p class="m-0 text-xs text-text-muted">{{ 'ACCOUNT.PHONE.UNVERIFIED' | translate }}</p>

                <div class="flex items-center gap-2 flex-wrap">
                    <p-button
                        (onClick)="save()"
                        [disabled]="!canSave()"
                        [loading]="saving()"
                        size="small"
                        data-testid="phone-save"
                        [label]="'ACCOUNT.PHONE.SAVE' | translate"
                    />

                    @if (stored()) {
                        <!--
                          A first-class action rather than a hidden one. Somebody who shared a number
                          and changed their mind needs the way out to be as visible as the way in.
                        -->
                        <p-button
                            (onClick)="remove()"
                            [text]="true"
                            severity="danger"
                            [disabled]="saving() || removing()"
                            [loading]="removing()"
                            size="small"
                            data-testid="phone-remove"
                            [label]="'ACCOUNT.PHONE.REMOVE' | translate"
                        />
                    }
                </div>

                @if (stored()) {
                    <p class="m-0 text-xs text-text-muted">
                        {{ 'ACCOUNT.PHONE.REMOVE_NOTE' | translate }}
                    </p>
                } @else {
                    <p class="m-0 text-xs text-text-muted" data-testid="phone-none">
                        {{ 'ACCOUNT.PHONE.NONE' | translate }}
                    </p>
                }
            }
        </div>
    `,
})
export class AccountPhoneComponent {
    private readonly users = inject(UserService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);
    private readonly settingsUi = inject(SettingsUiService);

    /** What is on the account right now, normalised, or null when there is none. */
    protected readonly stored = computed(() => this.users.self()?.phoneNumber ?? null);

    /** Null until the host's `GET /users/self` lands; an empty field would read as "no number". */
    protected readonly loading = computed(() => this.users.self() === null);

    protected readonly draft = signal('');
    protected readonly saving = signal(false);
    protected readonly removing = signal(false);

    private readonly check = computed(() => checkE164(this.draft()));

    /** The sentence under the box, or null. */
    protected readonly problemKey = computed(() => {
        const problem = this.check().problem;
        return problem && problem !== 'empty' ? e164ProblemKey(problem) : null;
    });

    /** Saveable when it parses and would actually change something. */
    protected readonly canSave = computed(() => {
        if (this.saving() || this.removing()) return false;
        const parsed = this.check().e164;
        return !!parsed && parsed !== this.stored();
    });

    constructor() {
        // Seeds the box from the account and re-seeds it whenever the stored number changes under
        // it - which is what a save or a remove does, including one made on another device.
        // `untracked` so the user's own typing does not feed back into this.
        effect(() => {
            const current = this.stored();
            untracked(() => this.draft.set(current ?? ''));
        });

        // The ledger's sharing card links here when the account has no number. Nothing about that
        // link can select this field, so the field selects itself: the settings dialog is a long
        // page and arriving at the top of it is indistinguishable from arriving nowhere.
        effect(() => {
            if (this.settingsUi.requestedAnchor() !== 'phone') return;
            this.settingsUi.consumeAnchor();
            untracked(() => this.reveal());
        });
    }

    protected async save(): Promise<void> {
        const parsed = this.check().e164;
        if (!parsed || this.saving()) return;

        this.saving.set(true);
        try {
            await new Promise<void>((resolve, reject) => {
                this.users
                    .setPhoneNumber(parsed)
                    .pipe(take(1))
                    .subscribe({next: () => resolve(), error: reject});
            });
            this.toast.success(this.translate.instant('ACCOUNT.PHONE.SAVED'));
        } catch (err) {
            this.toast.httpError(this.translate.instant('ACCOUNT.PHONE.SAVE_FAILED'), err);
        } finally {
            this.saving.set(false);
        }
    }

    protected async remove(): Promise<void> {
        if (this.removing()) return;

        this.removing.set(true);
        try {
            await new Promise<void>((resolve, reject) => {
                this.users
                    .removePhoneNumber()
                    .pipe(take(1))
                    .subscribe({next: () => resolve(), error: reject});
            });
            this.toast.success(this.translate.instant('ACCOUNT.PHONE.REMOVED'));
        } catch (err) {
            this.toast.httpError(this.translate.instant('ACCOUNT.PHONE.REMOVE_FAILED'), err);
        } finally {
            this.removing.set(false);
        }
    }

    /** Brings the field into view and puts the caret in it. */
    private reveal(): void {
        setTimeout(() => {
            try {
                const host = document.querySelector<HTMLElement>('[data-testid="account-phone"]');
                host?.scrollIntoView({block: 'center'});
                host?.querySelector('input')?.focus();
            } catch {
                // Landing on the right page without the scroll is still the right page.
            }
        });
    }
}
