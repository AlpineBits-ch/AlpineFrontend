import {ChangeDetectionStrategy, Component, computed, input, output} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Select} from 'primeng/select';
import {MultiSelect} from 'primeng/multiselect';
import {OnboardingPrompt, OnboardingPromptOption, OnboardingPromptType} from '../../../../dtos/response/guild-safety.dto';

/** One prompt's options, rendered the way the admin declared: MultipleChoice as selectable cards, Dropdown as a real select. Shared by the join wizard and the Channels & Roles screen. Purely controlled: it owns no selection state, which is what lets the wizard hold every answer until the single accept call at the end. */
@Component({
    selector: 'app-onboarding-prompt-step',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [FormsModule, Select, MultiSelect],
    template: `
        @if (isDropdown()) {
            @if (prompt().singleSelect) {
                <p-select (ngModelChange)="setSingle($event)" [filter]="options().length > 8"
                          [ngModel]="singleValue()" [options]="dropdownOptions()" [showClear]="!prompt().required"
                          appendTo="body" optionLabel="label" optionValue="value" placeholder="-" styleClass="w-full"/>
            } @else {
                <p-multiSelect (ngModelChange)="selectionChange.emit($event)" [filter]="options().length > 8"
                               [ngModel]="selected()" [options]="dropdownOptions()" appendTo="body" optionLabel="label"
                               optionValue="value" placeholder="-" styleClass="w-full"/>
            }
        } @else {
            <div class="grid gap-2 sm:grid-cols-2">
                @for (option of options(); track option.id) {
                    <button (click)="toggle(option)"
                            [class]="isSelected(option)
                                ? 'border-brand bg-[color-mix(in_srgb,var(--color-brand)_12%,transparent)]'
                                : 'border-border-subtle bg-card/60 hover:bg-hover hover:border-border-default'"
                            class="flex items-start gap-3 p-3 rounded-xl border text-left transition-colors"
                            type="button">

                        @if (emojiUrlFor(option); as url) {
                            <img [src]="url" alt="" class="w-5 h-5 object-contain shrink-0 mt-0.5"/>
                        } @else if (option.emoji) {
                            <span class="text-base leading-none shrink-0 mt-0.5">{{ option.emoji }}</span>
                        }

                        <span class="flex-1 min-w-0">
                            <span class="block text-sm font-medium text-text-primary truncate">{{ option.title }}</span>
                            @if (option.description) {
                                <span class="block text-xs text-text-muted mt-0.5 line-clamp-2">{{ option.description }}</span>
                            }
                        </span>

                        <span [class]="isSelected(option) ? 'border-brand bg-brand' : 'border-border-default'"
                              [class.rounded-full]="prompt().singleSelect"
                              [class.rounded]="!prompt().singleSelect"
                              class="w-4 h-4 shrink-0 mt-0.5 border grid place-items-center transition-colors">
                            @if (isSelected(option)) {
                                <i class="pi pi-check text-[0.5rem] text-white"></i>
                            }
                        </span>
                    </button>
                }
            </div>
        }
    `,
})
export class OnboardingPromptStepComponent {
    readonly prompt = input.required<OnboardingPrompt>();
    readonly selected = input<string[]>([]);
    /** Guild emoji id → presigned url, for options whose emoji is a custom one. */
    readonly emojiUrls = input<Record<string, string>>({});

    selectionChange = output<string[]>();

    /** Derived here rather than re-exporting the enum as a field: that couples the view to module-evaluation order, which is fragile under the test runner's module graph. */
    protected readonly isDropdown = computed(() => this.prompt().type === OnboardingPromptType.Dropdown);

    protected readonly options = computed(() =>
        [...this.prompt().options].sort((a, b) => a.position - b.position));

    protected readonly dropdownOptions = computed(() =>
        this.options().map(o => ({label: o.title, value: o.id ?? ''})));

    /** p-select wants an explicit null for "nothing chosen"; an empty array index is undefined. */
    protected readonly singleValue = computed<string | null>(() => this.selected()[0] ?? null);

    protected isSelected(option: OnboardingPromptOption): boolean {
        return !!option.id && this.selected().includes(option.id);
    }

    /** An option's `emoji` is either a unicode character or a guild emoji id, with no discriminator: a hit in the url map is the only reliable way to tell them apart. */
    protected emojiUrlFor(option: OnboardingPromptOption): string | null {
        return option.emoji ? this.emojiUrls()[option.emoji] ?? null : null;
    }

    protected setSingle(optionId: string | null): void {
        this.selectionChange.emit(optionId ? [optionId] : []);
    }

    protected toggle(option: OnboardingPromptOption): void {
        const id = option.id;
        if (!id) return;

        if (this.prompt().singleSelect) {
            // Re-picking the current answer clears it, unless the prompt is required: there, clearing would only produce a validation error the user can't act on.
            const clearing = this.selected().includes(id) && !this.prompt().required;
            this.selectionChange.emit(clearing ? [] : [id]);
            return;
        }

        this.selectionChange.emit(
            this.selected().includes(id) ? this.selected().filter(x => x !== id) : [...this.selected(), id]);
    }
}
