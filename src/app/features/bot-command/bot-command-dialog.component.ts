import {ChangeDetectionStrategy, Component, computed, effect, inject, signal} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {FormsModule} from '@angular/forms';
import {PrimeTemplate} from 'primeng/api';
import {switchMap} from 'rxjs';
import {BotCommandDialogService} from './bot-command-dialog.service';
import {BotCommandService} from '../../services/bot-command.service';
import {MessageStore} from '../../stores/message.store';
import {MessageEncryptionState} from '../../enums/message-encryption-state.enum';
import {MessageType} from '../../enums/message-type.enum';
import {BotCommandOptionDto} from '../../dtos/response/bot-command.dto';
import {InvokeBotCommandOptionDto} from '../../dtos/request/invoke-bot-command.dto';
import {DiscordOptionType, discordOptionInputKind, discordOptionPlaceholder} from '../../enums/discord-option-type.enum';

type OptionValue = string | boolean;

@Component({
    selector: 'app-bot-command-dialog',
    standalone: true,
    imports: [Dialog, Button, ToggleSwitch, FormsModule, PrimeTemplate],
    templateUrl: './bot-command-dialog.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BotCommandDialogComponent {
    protected readonly dialogService = inject(BotCommandDialogService);
    private readonly botCommandService = inject(BotCommandService);
    private readonly messageStore = inject(MessageStore);

    protected readonly optionValues = signal<Record<string, OptionValue>>({});

    protected readonly visible = computed(() => this.dialogService.request() !== null);

    protected readonly canSubmit = computed(() => {
        const request = this.dialogService.request();
        if (!request) return false;
        const values = this.optionValues();
        return request.command.options
            .filter(o => o.required && o.type !== DiscordOptionType.Boolean)
            .every(o => this.hasValue(values[o.name]));
    });

    protected readonly discordOptionInputKind = discordOptionInputKind;
    protected readonly discordOptionPlaceholder = discordOptionPlaceholder;
    protected readonly DiscordOptionType = DiscordOptionType;

    constructor() {
        effect(() => {
            const request = this.dialogService.request();
            const defaults: Record<string, OptionValue> = {};
            for (const option of request?.command.options ?? []) {
                defaults[option.name] = option.type === DiscordOptionType.Boolean ? false : '';
            }
            this.optionValues.set(defaults);
        });
    }

    protected setValue(name: string, value: OptionValue): void {
        this.optionValues.update(values => ({...values, [name]: value}));
    }

    protected submit(): void {
        const request = this.dialogService.request();
        if (!request || !this.canSubmit()) return;

        const values = this.optionValues();
        const options: InvokeBotCommandOptionDto[] = [];
        for (const option of request.command.options) {
            const value = values[option.name];
            if (!option.required && this.isDefaultValue(option, value)) continue;
            options.push({name: option.name, value: this.coerce(option, value)});
        }

        const tempId = crypto.randomUUID();
        const now = new Date();
        this.messageStore.addMessage({
            id: tempId,
            content: '',
            channelId: request.channelId,
            conversationId: undefined,
            authorId: request.command.botUserId,
            createdAt: now,
            updatedAt: now,
            isPending: true,
            isFailed: false,
            isBotCommandPlaceholder: true,
            attachments: [],
            inReplyTo: undefined,
            mentions: [],
            encryptionState: MessageEncryptionState.Plain,
            mlsEpoch: undefined,
            mlsSequenceNumber: undefined,
            senderDeviceId: undefined,
            type: MessageType.Message,
        });
        this.dialogService.close();

        this.botCommandService.invokeCommandWithRetry(
            request.guildId,
            request.channelId,
            {botUserId: request.command.botUserId, commandName: request.command.name, options},
        ).pipe(
            switchMap(() => this.botCommandService.awaitBotResponse(request.channelId, request.command.botUserId)),
        ).subscribe({
            next: () => this.messageStore.removeMessage(tempId),
            error: () => this.messageStore.failMessage(tempId),
        });
    }

    protected dismiss(): void {
        this.dialogService.close();
    }

    private hasValue(value: OptionValue | undefined): boolean {
        return typeof value === 'string' && value.trim().length > 0;
    }

    private isDefaultValue(option: BotCommandOptionDto, value: OptionValue | undefined): boolean {
        if (option.type === DiscordOptionType.Boolean) return value !== true;
        return !this.hasValue(value);
    }

    private coerce(option: BotCommandOptionDto, value: OptionValue | undefined): string | number | boolean {
        if (option.type === DiscordOptionType.Boolean) return !!value;
        if (option.type === DiscordOptionType.Integer || option.type === DiscordOptionType.Number) return Number(value);
        return String(value ?? '');
    }
}
