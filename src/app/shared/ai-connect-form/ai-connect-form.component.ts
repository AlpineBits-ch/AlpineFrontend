import {ChangeDetectionStrategy, Component, inject, input, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {AI_PROVIDER_IDS, AI_PROVIDER_META, AiProviderId} from '../../services/ai-provider';
import {AiCredentialsService} from '../../services/ai-credentials.service';
import {AiPrivacyNoteComponent} from '../ai-privacy-note/ai-privacy-note.component';

/**
 * Connect an AI provider account.
 *
 * Shared between the settings page and the connect state inside the wiki's draft dialog, so that
 * connecting from the point of use is the same act as connecting from settings - and so the
 * privacy note, the field labels and the storage behaviour cannot diverge between the two.
 */
@Component({
    selector: 'app-ai-connect-form',
    imports: [FormsModule, Button, TranslateModule, AiPrivacyNoteComponent],
    template: `
        <div class="flex flex-col gap-4">
            <app-ai-privacy-note [showBilling]="showBilling()" />

            <!-- Provider -->
            <div class="flex flex-col gap-2">
                <span class="text-xs font-medium text-text-secondary">
                    {{ 'AI.CONNECT.PROVIDER' | translate }}
                </span>
                <div class="flex flex-wrap gap-2">
                    @for (id of providerIds; track id) {
                        <button
                            (click)="selectProvider(id)"
                            [class.border-brand]="provider() === id"
                            [class.text-white]="provider() === id"
                            class="flex cursor-pointer items-center gap-2 rounded-lg border
                                       border-border bg-card px-3 py-2 text-[0.8125rem]
                                       text-text-secondary transition-colors hover:bg-hover"
                            type="button"
                        >
                            {{ meta[id].label }}
                            @if (credentials.configured().has(id)) {
                                <i class="pi pi-check-circle text-[0.6875rem] text-online"></i>
                            }
                        </button>
                    }
                </div>
            </div>

            <!-- Key. Never populated from storage: the service has no read-for-display path, and
                 a saved key is shown as its presence, not its value. -->
            <div class="flex flex-col gap-2">
                <div class="flex items-baseline justify-between gap-3">
                    <label class="text-xs font-medium text-text-secondary" for="ai-connect-key">
                        {{ 'AI.CONNECT.KEY' | translate }}
                    </label>
                    <a
                        [href]="meta[provider()].keyUrl"
                        class="text-[0.6875rem] text-brand-dim
                              hover:underline"
                        rel="noopener"
                        target="_blank"
                    >
                        {{ 'AI.CONNECT.GET_KEY' | translate }}
                    </a>
                </div>
                <input
                    [(ngModel)]="apiKey"
                    [placeholder]="
                        isConfigured()
                            ? ('AI.CONNECT.KEY_STORED' | translate)
                            : ('AI.CONNECT.KEY_PLACEHOLDER' | translate)
                    "
                    autocomplete="off"
                    class="w-full rounded-lg border border-border bg-card px-3 py-2 font-mono
                              text-[0.8125rem] text-text-primary outline-none placeholder-white/25
                              focus:border-brand-dim"
                    id="ai-connect-key"
                    spellcheck="false"
                    type="password"
                />
                @if (isConfigured()) {
                    <p class="text-[0.6875rem] text-text-muted">
                        {{ 'AI.CONNECT.KEY_REPLACE_HINT' | translate }}
                    </p>
                }
            </div>

            <!-- Model -->
            <div class="flex flex-col gap-2">
                <label class="text-xs font-medium text-text-secondary" for="ai-connect-model">
                    {{ 'AI.CONNECT.MODEL' | translate }}
                </label>
                <input
                    [(ngModel)]="model"
                    class="w-full rounded-lg border border-border bg-card px-3 py-2 font-mono
                              text-[0.8125rem] text-text-primary outline-none placeholder-white/25
                              focus:border-brand-dim"
                    id="ai-connect-model"
                    spellcheck="false"
                    type="text"
                />
            </div>

            @if (error(); as messageKey) {
                <p class="text-[0.8125rem] text-offline">{{ messageKey | translate }}</p>
            }

            <div class="flex items-center gap-2">
                <p-button
                    (onClick)="save()"
                    [label]="'AI.CONNECT.SAVE' | translate"
                    [loading]="busy()"
                    severity="primary"
                    size="small"
                />
                @if (isConfigured()) {
                    <p-button
                        (onClick)="remove()"
                        [label]="'AI.CONNECT.REMOVE' | translate"
                        [loading]="busy()"
                        severity="secondary"
                        size="small"
                    />
                }
            </div>
        </div>
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AiConnectFormComponent {
    readonly showBilling = input(true);

    readonly connected = output<void>();

    protected readonly credentials = inject(AiCredentialsService);
    protected readonly providerIds = AI_PROVIDER_IDS;
    protected readonly meta = AI_PROVIDER_META;

    protected readonly provider = signal<AiProviderId>(this.credentials.selectedProvider() ?? 'anthropic');
    protected readonly busy = signal(false);
    /** A translation key, not a sentence - this component renders in three languages. */
    protected readonly error = signal<string | null>(null);

    protected readonly apiKey = signal('');
    protected model = this.credentials.selectedProvider()
        ? this.credentials.selectedModel(AI_PROVIDER_META[this.provider()].defaultModel)
        : AI_PROVIDER_META[this.provider()].defaultModel;

    constructor() {
        void this.credentials.refresh();
    }

    protected isConfigured(): boolean {
        return this.credentials.configured().has(this.provider());
    }

    protected selectProvider(id: AiProviderId): void {
        this.provider.set(id);
        // The model name belongs to the provider, so carrying the previous one across would
        // send a Claude model id to OpenAI.
        this.model = AI_PROVIDER_META[id].defaultModel;
        this.apiKey.set('');
        this.error.set(null);
    }

    protected async save(): Promise<void> {
        const key = this.apiKey().trim();
        // An empty field with a key already stored means "keep the key, change the model", which
        // is a real thing to want and must not wipe the credential.
        if (!key && !this.isConfigured()) {
            this.error.set('AI.CONNECT.ERROR_NO_KEY');
            return;
        }
        this.busy.set(true);
        this.error.set(null);
        try {
            if (key) await this.credentials.setKey(this.provider(), key);
            this.credentials.selectProvider(this.provider(), this.model.trim());
            // `selectProvider` writes localStorage, which nothing reactive is watching, so a save
            // that only switches between two already-configured providers would leave
            // `WikiAiService.activeProvider` computed against the previous choice. Refreshing
            // replaces the `configured` set and invalidates it. Saving a *key* does not need this -
            // `setKey` already updates that signal - but the model-only path is the common one.
            await this.credentials.refresh();
            this.apiKey.set('');
            this.connected.emit();
        } catch {
            this.error.set('AI.CONNECT.ERROR_KEYCHAIN');
        } finally {
            this.busy.set(false);
        }
    }

    protected async remove(): Promise<void> {
        this.busy.set(true);
        try {
            await this.credentials.clearKey(this.provider());
            this.apiKey.set('');
        } finally {
            this.busy.set(false);
        }
    }
}
