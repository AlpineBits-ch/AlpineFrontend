import {ChangeDetectionStrategy, Component, computed, inject, input, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';

import {TagChipComponent} from '../../../../components/tag-chip/tag-chip.component';
import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {ToastService} from '../../../../services/toast.service';
import {SceneTagDto} from '../../../../dtos/response/scene.dto';

const MAX_TAGS_PER_GUILD = 40;

/** The guild's tag vocabulary. Creating and renaming is a GM job; applying one is not. */
@Component({
    selector: 'app-scene-tag-editor',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule, FormsModule, TagChipComponent],
    templateUrl: './scene-tag-editor.component.html',
    styleUrl: './scene-editor.component.css',
    host: {'(document:keydown.escape)': 'closed.emit()'},
})
export class SceneTagEditorComponent {
    readonly guildId = input.required<string>();

    readonly closed = output<void>();

    private readonly taxonomy = inject(SceneTaxonomyService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly name = signal('');
    protected readonly color = signal('');
    protected readonly moderated = signal(false);
    protected readonly saving = signal(false);
    protected readonly editingId = signal<string | null>(null);

    protected readonly tags = computed(() => this.taxonomy.tags(this.guildId()));

    protected readonly full = computed(() => this.tags().length >= MAX_TAGS_PER_GUILD);

    protected readonly valid = computed(() => this.name().trim().length > 0);

    /** What the chip will look like once saved, so a colour is picked by eye rather than by hex. */
    protected readonly preview = computed(() => ({
        name: this.name().trim() || this.translate.instant('SCENE.ARCHIVE.NEW_TAG'),
        color: this.color().trim() || '#000000',
    }));

    protected edit(tag: SceneTagDto): void {
        this.editingId.set(tag.id);
        this.name.set(tag.name);
        this.color.set(tag.color === '#000000' ? '' : tag.color);
        this.moderated.set(tag.moderated);
    }

    protected reset(): void {
        this.editingId.set(null);
        this.name.set('');
        this.color.set('');
        this.moderated.set(false);
    }

    protected save(): void {
        if (!this.valid() || this.saving()) return;
        this.saving.set(true);

        const done = {
            next: () => {
                this.saving.set(false);
                this.reset();
            },
            error: (err: unknown) => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('SCENE.ARCHIVE.TAG_ERROR'), err);
            },
        };

        const editingId = this.editingId();
        if (editingId) {
            this.taxonomy
                .updateTag(this.guildId(), editingId, {
                    name: this.name().trim(),
                    color: this.color().trim() || '#000000',
                    moderated: this.moderated(),
                })
                .subscribe(done);
            return;
        }

        this.taxonomy
            .createTag(this.guildId(), {
                name: this.name().trim(),
                color: this.color().trim() || null,
                moderated: this.moderated(),
            })
            .subscribe(done);
    }

    protected remove(tag: SceneTagDto): void {
        if (this.saving()) return;
        this.saving.set(true);

        this.taxonomy.deleteTag(this.guildId(), tag.id).subscribe({
            next: () => {
                this.saving.set(false);
                if (this.editingId() === tag.id) this.reset();
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('SCENE.ARCHIVE.TAG_ERROR'), err);
            },
        });
    }
}
