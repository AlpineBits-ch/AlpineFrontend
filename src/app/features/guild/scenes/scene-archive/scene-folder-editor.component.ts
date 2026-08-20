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
import {Select} from 'primeng/select';

import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {ToastService} from '../../../../services/toast.service';
import {SceneFolderDto} from '../../../../dtos/response/scene.dto';
import {ARCHIVE_COLOR_FALLBACK, ARCHIVE_COLORS} from './archive-colors';

/** Creates or edits one shelf. Deleting from here removes the shelf, never the scenes on it. */
@Component({
    selector: 'app-scene-folder-editor',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule, FormsModule, Select],
    templateUrl: './scene-folder-editor.component.html',
    styleUrl: './scene-editor.component.css',
    host: {'(document:keydown.escape)': 'closed.emit()'},
})
export class SceneFolderEditorComponent {
    readonly guildId = input.required<string>();
    /** Null creates a new shelf. */
    readonly folder = input<SceneFolderDto | null>(null);

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

    protected readonly swatches = ARCHIVE_COLORS;
    protected readonly fallbackColor = ARCHIVE_COLOR_FALLBACK;

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
            untracked(() => {
                // Seeded once. A later patch to the same folder must not throw away what is being
                // typed into the form.
                if (this.seeded) return;
                this.seeded = true;
                this.name.set(held?.name ?? '');
                this.icon.set(held?.icon ?? '');
                this.color.set(held?.color ?? '');
                this.parentId.set(held?.parentFolderId ?? '');
            });
        });
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
                    icon: this.icon().trim(),
                    color: this.color().trim(),
                    // Empty string is "move to the root", which is a real instruction here rather
                    // than an absent one: the field is always sent from this form.
                    parentFolderId: this.mayReparent() ? this.parentId() : undefined,
                })
                .subscribe(done);
            return;
        }

        this.taxonomy
            .createFolder(this.guildId(), {
                name: this.name().trim(),
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
                this.toast.httpError(this.translate.instant('SCENE.ARCHIVE.FOLDER_ERROR'), err);
            },
        });
    }
}
