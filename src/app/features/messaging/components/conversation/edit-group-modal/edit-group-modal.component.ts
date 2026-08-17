import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    model,
    OnDestroy,
    output,
    signal,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Dialog} from 'primeng/dialog';
import {InputText} from 'primeng/inputtext';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {ConversationDto} from '../../../../../dtos/response/conversation.dto';
import {ConversationService} from '../../../../../services/conversation.service';
import {ConversationStore} from '../../../../../stores/conversation.store';
import {ConversationUtilsService} from '../../../../../services/conversation-utils.service';
import {ToastService} from '../../../../../services/toast.service';
import {ImageCropperComponent} from '../../../../../components/image-cropper/image-cropper.component';
import {AuthImageDirective} from '../../../../../directives/auth-image.directive';

@Component({
    selector: 'app-edit-group-modal',
    imports: [
        Dialog,
        InputText,
        FormsModule,
        PrimeTemplate,
        TranslateModule,
        ImageCropperComponent,
        AuthImageDirective,
    ],
    templateUrl: './edit-group-modal.component.html',
    styleUrl: './edit-group-modal.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditGroupModalComponent implements OnDestroy {
    readonly visible = model.required<boolean>();
    readonly conversation = input.required<ConversationDto>();
    readonly saved = output<ConversationDto>();

    protected readonly name = signal('');
    protected readonly saving = signal(false);
    protected readonly cropVisible = signal(false);
    protected readonly cropSrc = signal('');
    /** What the circle shows: an object URL while a pick is pending, the stored icon otherwise. */
    protected readonly iconPreview = signal<string | null>(null);
    protected readonly pendingIconFile = signal<File | null>(null);
    protected readonly iconRemoved = signal(false);

    protected readonly nameLimit = 100;
    /** Matches the server's cap. */
    protected readonly maxIconMb = 8;

    protected readonly initial = computed(() =>
        (
            this.name().trim()[0] ?? this.conversationUtils.getChatAvatarLabel(this.conversation())
        ).toUpperCase(),
    );

    /** Nothing to save until a field moved, which is also what greys the button out. */
    protected readonly dirty = computed(
        () =>
            this.name().trim() !== (this.conversation().name ?? '') ||
            this.pendingIconFile() !== null ||
            this.iconRemoved(),
    );

    private readonly conversationService = inject(ConversationService);
    private readonly conversationStore = inject(ConversationStore);
    private readonly conversationUtils = inject(ConversationUtilsService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);
    private previewObjectUrl: string | null = null;

    constructor() {
        // Reopening has to show what is stored now, not what was typed and abandoned last time.
        effect(() => {
            if (!this.visible()) return;
            this.reset();
        });
    }

    ngOnDestroy(): void {
        this.releasePreview();
    }

    protected onIconSelected(event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        // Reading a phone photo into a data URL freezes the dialog for seconds before the server
        // would have refused it anyway.
        if (file.size > this.maxIconMb * 1024 * 1024) {
            this.toast.error(this.translate.instant('GROUP_EDIT.ICON_TOO_LARGE', {max: this.maxIconMb}));
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            this.cropSrc.set(reader.result as string);
            this.cropVisible.set(true);
        };
        reader.readAsDataURL(file);
    }

    protected onCropConfirmed(file: File): void {
        this.cropVisible.set(false);
        this.releasePreview();
        this.previewObjectUrl = URL.createObjectURL(file);
        this.pendingIconFile.set(file);
        this.iconRemoved.set(false);
        this.iconPreview.set(this.previewObjectUrl);
    }

    protected removeIcon(): void {
        this.releasePreview();
        this.iconPreview.set(null);
        this.pendingIconFile.set(null);
        this.iconRemoved.set(true);
    }

    protected cancel(): void {
        this.visible.set(false);
    }

    protected save(): void {
        if (this.saving() || !this.dirty()) return;
        this.saving.set(true);

        const id = this.conversation().id;
        const nameChanged = this.name().trim() !== (this.conversation().name ?? '');
        const file = this.pendingIconFile();

        const renameThenClose = (): void => {
            if (!nameChanged) return this.finish(null);
            this.conversationService.updateConversation(id, this.name().trim() || null).subscribe({
                next: conv => this.finish(conv),
                error: () => this.fail('GROUP_EDIT.SAVE_ERROR'),
            });
        };

        if (file) {
            this.conversationService.uploadIcon(id, file).subscribe({
                next: () => renameThenClose(),
                error: () => this.fail('GROUP_EDIT.ICON_ERROR'),
            });
        } else if (this.iconRemoved()) {
            this.conversationService.removeIcon(id).subscribe({
                next: () => renameThenClose(),
                error: () => this.fail('GROUP_EDIT.ICON_ERROR'),
            });
        } else {
            renameThenClose();
        }
    }

    /**
     * The realtime push also carries this change, but it can lose the race with the dialog closing,
     * so the store is patched from what was just sent rather than left waiting for it.
     */
    private finish(conv: ConversationDto | null): void {
        const held = this.conversationStore.entityMap()[this.conversation().id];
        const iconUpdatedAt = this.pendingIconFile()
            ? new Date().toISOString()
            : this.iconRemoved()
              ? null
              : (held?.iconUpdatedAt ?? null);

        this.conversationStore.applyEdit(
            this.conversation().id,
            conv ? (conv.name ?? null) : (held?.name ?? null),
            iconUpdatedAt,
        );

        this.saving.set(false);
        this.visible.set(false);
        if (conv) this.saved.emit(conv);
    }

    private fail(key: string): void {
        this.saving.set(false);
        this.toast.error(this.translate.instant(key));
    }

    private reset(): void {
        this.releasePreview();
        this.name.set(this.conversation().name ?? '');
        this.pendingIconFile.set(null);
        this.iconRemoved.set(false);
        this.iconPreview.set(this.conversationUtils.getChatIconUrl(this.conversation()));
        this.saving.set(false);
    }

    private releasePreview(): void {
        if (!this.previewObjectUrl) return;
        URL.revokeObjectURL(this.previewObjectUrl);
        this.previewObjectUrl = null;
    }
}
