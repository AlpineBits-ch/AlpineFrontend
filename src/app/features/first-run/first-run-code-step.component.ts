import {ChangeDetectionStrategy, Component, computed, input, output, signal} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';

/** English ordinal for a one-based position. */
function ordinalOf(position: number): string {
    const tens = position % 100;
    if (tens >= 11 && tens <= 13) return `${position}th`;
    switch (position % 10) {
        case 1:
            return `${position}st`;
        case 2:
            return `${position}nd`;
        case 3:
            return `${position}rd`;
        default:
            return `${position}th`;
    }
}

function fold(word: string): string {
    return word.trim().toLowerCase();
}

@Component({
    selector: 'app-first-run-code-step',
    standalone: true,
    imports: [TranslateModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="flex flex-col gap-6" data-testid="first-run-code">
            <div class="flex flex-col gap-2">
                <h1 class="m-0 text-2xl font-semibold text-text-primary">
                    {{ 'FIRST_RUN.CODE.TITLE' | translate }}
                </h1>
                <p class="m-0 max-w-md text-sm text-text-secondary">
                    {{ 'FIRST_RUN.CODE.SUBTITLE' | translate }}
                </p>
            </div>

            <div class="rounded-2xl border border-border bg-card px-5 py-4">
                <code
                    [attr.aria-label]="'FIRST_RUN.CODE.CODE_LABEL' | translate"
                    class="block select-all break-words text-center font-mono text-base leading-9 text-brand-dim [word-spacing:0.4rem]"
                    data-testid="first-run-code-value"
                    >{{ code() }}</code
                >
            </div>

            <div class="flex items-center gap-3">
                <button
                    (click)="copy()"
                    class="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-hover"
                    data-testid="first-run-copy"
                    type="button"
                >
                    <i class="pi pi-copy text-xs"></i>
                    {{ 'FIRST_RUN.CODE.COPY' | translate }}
                </button>
                @if (copied()) {
                    <span
                        class="flex items-center gap-1.5 text-sm text-online"
                        data-testid="first-run-copied"
                    >
                        <i class="pi pi-check text-xs"></i>
                        {{ 'FIRST_RUN.CODE.COPIED' | translate }}
                    </span>
                }
            </div>

            <div class="flex flex-col gap-2">
                <label
                    class="text-sm text-text-primary"
                    data-testid="first-run-confirm-prompt"
                    for="first-run-confirm-word"
                >
                    {{
                        'FIRST_RUN.CODE.CONFIRM_PROMPT'
                            | translate: {ordinal: ordinal(), position: position()}
                    }}
                </label>
                <input
                    (input)="onInput($event)"
                    [attr.placeholder]="
                        'FIRST_RUN.CODE.CONFIRM_PLACEHOLDER' | translate: {position: position()}
                    "
                    [value]="typed()"
                    autocapitalize="off"
                    autocomplete="off"
                    class="w-full max-w-xs rounded-lg border border-border bg-card px-3 py-2 font-mono text-sm text-text-primary outline-none focus:border-brand"
                    data-testid="first-run-confirm-input"
                    id="first-run-confirm-word"
                    spellcheck="false"
                    type="text"
                />
                <p class="m-0 text-xs text-text-muted">{{ 'FIRST_RUN.CODE.CONFIRM_HINT' | translate }}</p>
            </div>

            @if (error()) {
                <p class="m-0 text-sm text-offline" data-testid="first-run-error">
                    <i class="pi pi-exclamation-circle mr-1.5"></i>{{ error() }}
                </p>
            }
        </div>
    `,
})
export class FirstRunCodeStepComponent {
    readonly code = input.required<string>();
    /** Zero-based; the parent picks which word so the choice is testable upstream. */
    readonly wordIndex = input.required<number>();
    readonly error = input<string | null>(null);
    readonly confirmed = output<void>();

    protected readonly typed = signal('');
    protected readonly copied = signal(false);

    protected readonly position = computed(() => this.wordIndex() + 1);
    protected readonly ordinal = computed(() => ordinalOf(this.position()));

    private readonly expected = computed(() => fold(this.code().split(/\s+/)[this.wordIndex()] ?? ''));
    private emittedFor: string | null = null;

    protected async copy(): Promise<void> {
        try {
            await navigator.clipboard.writeText(this.code());
            this.copied.set(true);
        } catch {
            // Clipboard access can be refused; the code is on screen to be written down anyway.
            this.copied.set(false);
        }
    }

    protected onInput(event: Event): void {
        const value = (event.target as HTMLInputElement).value;
        this.typed.set(value);

        const word = fold(value);
        if (!word || word !== this.expected()) {
            this.emittedFor = null;
            return;
        }
        if (this.emittedFor === word) return;
        this.emittedFor = word;
        this.confirmed.emit();
    }
}
