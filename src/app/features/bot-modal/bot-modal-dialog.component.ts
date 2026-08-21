import {ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {FormsModule} from '@angular/forms';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {BotModalDialogService} from './bot-modal-dialog.service';
import {BotCommandService} from '../../services/bot-command.service';
import {BotComponentPayload, BotComponentType} from '../../dtos/bot-component.dto';

/** Discord's text-input styles. Anything else on a `type: 4` is treated as single-line. */
const enum TextInputStyle {
    Paragraph = 2,
}

/** How deep a bot's component tree is followed before it is assumed to be malformed. */
const MaxRowDepth = 4;

/** One field, after the action-row wrapper has been unwrapped. */
export interface ModalField {
    /** `track` key. Index-prefixed because `custom_id` is bot-chosen and may repeat. */
    key: string;
    /** The bot's handle for this field; what the answer is keyed by on the way back. */
    customId: string;
    label: string;
    placeholder: string;
    required: boolean;
    minLength: number | null;
    maxLength: number | null;
    /** Style 2 - render a textarea rather than a single-line input. */
    paragraph: boolean;
    /** Whatever the bot prefilled the field with. */
    initialValue: string;
    /** Set when the payload asked for something this dialog cannot render or cannot answer. */
    unsupported: boolean;
}

/** Mutable state for one showing of the dialog, reset wholesale when a new modal arrives. */
interface ModalFormState {
    values: Record<string, string>;
    /**
     * Validation messages stay hidden until the first submit attempt. A form that turns red before
     * it has been touched reads as broken; one that stays silent after a rejected Submit reads as
     * a dead button.
     */
    attempted: boolean;
    /** The last failure from the submit route, already turned into something a user can act on. */
    error: string | null;
}

/** Turns the tolerated whole numbers into a usable bound, and everything else into "no bound". */
function bound(raw: number | null | undefined): number | null {
    return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
}

/** Unwraps action rows into the fields they hold. */
export function flattenModalRows(components: BotComponentPayload[], depth = 0): BotComponentPayload[] {
    if (depth > MaxRowDepth) return [];
    const out: BotComponentPayload[] = [];
    for (const component of components) {
        if (component.type === BotComponentType.ActionRow && component.components?.length) {
            out.push(...flattenModalRows(component.components, depth + 1));
        } else {
            out.push(component);
        }
    }
    return out;
}

/** Reads one component of a modal payload as a field this dialog can put on screen. */
export function toModalField(component: BotComponentPayload, index: number): ModalField {
    const customId = component.custom_id?.trim() ?? '';
    return {
        key: `${index}:${customId}`,
        customId,
        label: component.label?.trim() || customId || `Field ${index + 1}`,
        placeholder: component.placeholder ?? '',
        required: component.required === true,
        minLength: bound(component.min_length),
        maxLength: bound(component.max_length),
        paragraph: component.style === TextInputStyle.Paragraph,
        initialValue: component.value ?? '',
        // A text input with no custom_id is unanswerable: the bot keys the reply on it, so there is
        // nothing to send the typed value back as.
        unsupported: component.type !== BotComponentType.TextInput || customId.length === 0,
    };
}

/** The reason this field cannot be sent, or null. */
export function validateModalField(field: ModalField, raw: string): string | null {
    if (field.required && raw.trim().length === 0) return 'This field is required.';
    if (raw.length === 0) return null;
    if (field.minLength !== null && raw.length < field.minLength) {
        return `Must be at least ${field.minLength} characters.`;
    }
    if (field.maxLength !== null && raw.length > field.maxLength) {
        return `Must be at most ${field.maxLength} characters.`;
    }
    return null;
}

/** Builds the `components` of a modal-submit body. */
export function buildModalSubmitRows(
    fields: ModalField[],
    values: Record<string, string>,
): BotComponentPayload[] {
    return fields
        .filter(field => !field.unsupported)
        .map(field => ({
            type: BotComponentType.ActionRow,
            components: [
                {
                    type: BotComponentType.TextInput,
                    custom_id: field.customId,
                    value: values[field.key] ?? '',
                },
            ],
        }));
}

/** Turns a failed submit into copy that tells the user which of the three things went wrong. */
export function describeModalSubmitFailure(error: unknown): string {
    if (!(error instanceof HttpErrorResponse)) return 'Something went wrong sending this form.';
    switch (error.status) {
        case 0:
            return 'Could not reach the server. Check your connection and try again.';
        case 403:
            return 'You do not have permission to send messages in this channel, so this form cannot be submitted.';
        case 404:
            return 'This bot is no longer available in this server, so it cannot receive this form.';
        default:
            return 'Something went wrong sending this form.';
    }
}

/** Renders a modal a bot asked for, and sends the answer back. */
@Component({
    selector: 'app-bot-modal-dialog',
    standalone: true,
    imports: [Dialog, Button, PrimeTemplate, FormsModule],
    templateUrl: './bot-modal-dialog.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BotModalDialogComponent {
    protected readonly dialogService = inject(BotModalDialogService);
    private readonly botCommandService = inject(BotCommandService);

    protected readonly visible = computed(() => this.dialogService.request() !== null);

    protected readonly title = computed(
        () => this.dialogService.request()?.title?.trim() || 'A bot needs some details',
    );

    protected readonly fields = computed<ModalField[]>(() =>
        flattenModalRows(this.dialogService.request()?.components ?? []).map(toModalField),
    );

    /**
     * Derived from {@link fields} rather than reset by an effect, so a second modal replacing the
     * first can never be typed into with the previous one's answers still in the boxes.
     */
    protected readonly form = linkedSignal<ModalField[], ModalFormState>({
        source: this.fields,
        computation: fields => ({
            values: Object.fromEntries(fields.map(field => [field.key, field.initialValue])),
            attempted: false,
            error: null,
        }),
    });

    protected readonly submitting = signal(false);

    /**
     * False when the payload is missing something the submit route needs in the path or body. The
     * contract types `guildId` and `customId` as nullable; without either there is no request to
     * make, and offering Submit would be the same lie the read-only version of this dialog existed
     * to avoid.
     */
    protected readonly answerable = computed(() => {
        const request = this.dialogService.request();
        return !!request?.guildId && !!request.customId?.trim();
    });

    protected readonly fieldErrors = computed<Record<string, string>>(() => {
        const values = this.form().values;
        const errors: Record<string, string> = {};
        for (const field of this.fields()) {
            if (field.unsupported) continue;
            const error = validateModalField(field, values[field.key] ?? '');
            if (error) errors[field.key] = error;
        }
        return errors;
    });

    protected setValue(key: string, value: string): void {
        this.form.update(state => ({...state, values: {...state.values, [key]: value}}));
    }

    protected submit(): void {
        const request = this.dialogService.request();
        if (!request || this.submitting()) return;

        this.form.update(state => ({...state, attempted: true, error: null}));
        if (Object.keys(this.fieldErrors()).length > 0) return;

        const guildId = request.guildId;
        const customId = request.customId?.trim();
        if (!guildId || !customId) return;

        this.submitting.set(true);
        this.botCommandService
            .submitModal(guildId, request.channelId, {
                botUserId: request.botUserId,
                customId,
                components: buildModalSubmitRows(this.fields(), this.form().values),
            })
            .subscribe({
                next: () => {
                    this.submitting.set(false);
                    this.dialogService.close();
                },
                error: (error: unknown) => {
                    this.submitting.set(false);
                    this.form.update(state => ({...state, error: describeModalSubmitFailure(error)}));
                },
            });
    }

    protected dismiss(): void {
        this.dialogService.close();
    }
}
