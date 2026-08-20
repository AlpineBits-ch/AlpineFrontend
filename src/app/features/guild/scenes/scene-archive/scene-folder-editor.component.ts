import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    output,
    signal,
    untracked,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {PrimeTemplate} from 'primeng/api';
import {Dialog} from 'primeng/dialog';
import {Select} from 'primeng/select';

import {EmojiPickerButtonComponent} from '../../../messaging/components/conversation/composer/emoji-picker-button/emoji-picker-button.component';
import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {ToastService} from '../../../../services/toast.service';
import {SceneFolderDto} from '../../../../dtos/response/scene.dto';
import {ARCHIVE_COLOR_FALLBACK, ARCHIVE_COLORS, isNoColor} from './archive-colors';

/** Creates or edits one shelf. Deleting from here removes the shelf, never the scenes on it. */
@Component({
    selector: 'app-scene-folder-editor',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule, FormsModule, Dialog, PrimeTemplate, Select, EmojiPickerButtonComponent],
    templateUrl: './scene-folder-editor.component.html',
    styleUrl: './scene-editor.component.css',
})
export class SceneFolderEditorComponent {
    readonly guildId = input.required<string>();
    /** Null creates a new shelf. */
    readonly folder = input<SceneFolderDto | null>(null);
    /** Where a new shelf starts out. Ignored once `folder` holds one. */
    readonly seedParentId = input<string | null>(null);

    readonly closed = output<void>();

    private readonly taxonomy = inject(SceneTaxonomyService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly name = signal('');
    protected readonly icon = signal('');
    protected readonly color = signal('');
    protected readonly parentId = signal<string>('');
    protected readonly saving = signal(false);
    protected readonly confirmingDelete = signal(false);
    private seeded = false;

    protected get swatches(): readonly string[] {
        return ARCHIVE_COLORS;
    }

    protected get fallbackColor(): string {
        return ARCHIVE_COLOR_FALLBACK;
    }

    protected readonly isNew = computed(() => !this.folder());

    /** Only root folders may be parents, and a folder can never be its own. */
    protected readonly parentOptions = computed(() =>
        this.taxonomy.folders(this.guildId()).filter(f => !f.parentFolderId && f.id !== this.folder()?.id),
    );

    /** The empty value is a real choice here: it means "keep this one at the top level". */
    protected readonly parentChoices = computed(() => [
        {label: this.translate.instant('SCENE.ARCHIVE.FOLDER_NO_PARENT') as string, value: ''},
        ...this.parentOptions().map(folder => ({label: folder.name, value: folder.id})),
    ]);

    /** A folder holding children cannot itself become a child: that would put its children at depth three. */
    protected readonly mayReparent = computed(() => {
        const current = this.folder();
        if (!current) return true;
        return !this.taxonomy.folders(this.guildId()).some(f => f.parentFolderId === current.id);
    });

    protected readonly valid = computed(() => this.name().trim().length > 0);

    constructor() {
        effect(() => {
            const held = this.folder();
            const seed = this.seedParentId();
            untracked(() => {
                // Seeded once. A later patch to the same folder must not throw away what is being
                // typed into the form.
                if (this.seeded) return;
                this.seeded = true;
                this.name.set(held?.name ?? '');
                this.icon.set(held?.icon ?? '');
                this.color.set(isNoColor(held?.color) ? '' : (held?.color ?? ''));
                this.parentId.set(held ? (held.parentFolderId ?? '') : this.seedParent(seed));
            });
        });
    }

    /** A seed standing on a child resolves to that child's parent: the tree only goes two deep. */
    private seedParent(seed: string | null): string {
        if (!seed) return '';
        const held = this.taxonomy.folders(this.guildId()).find(f => f.id === seed);
        if (!held) return '';
        return held.parentFolderId ?? held.id;
    }

    protected save(): void {
        if (!this.valid() || this.saving()) return;
        this.saving.set(true);

        const held = this.folder();
        const done = {
            next: () => {
                this.saving.set(false);
                this.closed.emit();
            },
            error: (err: unknown) => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('SCENE.ARCHIVE.FOLDER_ERROR'), err);
            },
        };

        if (held) {
            this.taxonomy
                .updateFolder(this.guildId(), held.id, {
                    name: this.name().trim(),
                    // The folder PATCH clears a field with an empty string, never with null or the
                    // #000000 sentinel. Same for parentFolderId, where "" means the root.
                    icon: this.icon().trim(),
                    color: this.color().trim(),
                    parentFolderId: this.mayReparent() ? this.parentId() : undefined,
                })
                .subscribe(done);
            return;
        }

        this.taxonomy
            .createFolder(this.guildId(), {
                name: this.name().trim(),
                // Create says "nothing chosen" with null.
                icon: this.icon().trim() || null,
                color: this.color().trim() || null,
                parentFolderId: this.parentId() || null,
            })
            .subscribe(done);
    }

    protected remove(): void {
        const held = this.folder();
        if (!held || this.saving()) return;

        this.saving.set(true);
        this.taxonomy.deleteFolder(this.guildId(), held.id).subscribe({
            next: () => {
                this.saving.set(false);
                this.closed.emit();
            },
            error: err => {
                this.saving.set(false);
                this.confirmingDelete.set(false);
                this.toast.httpError(this.translate.instant('SCENE.ARCHIVE.FOLDER_ERROR'), err);
            },
        });
    }
}
