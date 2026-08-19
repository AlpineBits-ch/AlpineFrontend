import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    model,
    output,
    signal,
    untracked,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {MessageDto} from '../../../../../dtos/response/message.dto';
import {ThreadRegistryService} from '../../../../../services/thread-registry.service';
import {ToastService} from '../../../../../services/toast.service';
import {
    decodeBody,
    readableContent,
    UNDECRYPTABLE_SHORT,
} from '../../../../../helpers/message-content.helper';

/** How much of the starter is offered as the thread's name. */
const NAME_WORDS = 5;
const NAME_MAX = 90;

@Component({
    selector: 'app-create-thread-dialog',
    imports: [Dialog, Button, InputText, FormsModule, PrimeTemplate, TranslateModule],
    templateUrl: './create-thread-dialog.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreateThreadDialogComponent {
    readonly visible = model(false);
    readonly channelId = input.required<string>();
    readonly starter = input<MessageDto | null>(null);

    readonly created = output<string>();

    readonly name = signal('');
    readonly firstMessage = signal('');
    readonly submitting = signal(false);

    protected readonly starterPreview = computed(() => {
        const message = this.starter();
        return message ? readableContent(message, UNDECRYPTABLE_SHORT) : '';
    });

    private readonly registry = inject(ThreadRegistryService);
    private readonly toastService = inject(ToastService);
    private readonly translate = inject(TranslateService);

    constructor() {
        effect(() => {
            if (!this.visible()) return;
            const starter = this.starter();
            untracked(() => {
                this.name.set(starter ? suggestName(starter) : '');
                this.firstMessage.set('');
            });
        });
    }

    submit(): void {
        const name = this.name().trim();
        const starter = this.starter();
        if (!name || !starter || this.submitting()) return;

        this.submitting.set(true);
        const content = this.firstMessage().trim();
        this.registry
            .createFromMessage(this.channelId(), starter.id, content ? {name, content} : {name})
            .subscribe({
                next: threadId => {
                    this.submitting.set(false);
                    this.visible.set(false);
                    this.created.emit(threadId);
                },
                error: err => {
                    this.submitting.set(false);
                    this.toastService.httpError(this.translate.instant('THREAD.CREATE_ERROR'), err);
                },
            });
    }
}

/** Ciphertext this device cannot read has no words to borrow, so the field opens blank. */
function suggestName(message: MessageDto): string {
    if (message.undecryptable) return '';
    const words = decodeBody(message.content).trim().split(/\s+/).filter(Boolean).slice(0, NAME_WORDS);
    return words.join(' ').slice(0, NAME_MAX);
}
