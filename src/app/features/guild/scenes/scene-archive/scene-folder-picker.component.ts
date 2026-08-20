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
import {TranslateModule} from '@ngx-translate/core';

import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {SceneFolderDto} from '../../../../dtos/response/scene.dto';

/** One folder as the picker lists it, carrying the nesting a flat list cannot show. */
interface FolderRow {
    folder: SceneFolderDto;
    child: boolean;
    parentName: string | null;
}

/** Choosing a shelf. The detail sheet files a finished scene with it; the dialog seeds a new one. */
@Component({
    selector: 'app-scene-folder-picker',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [FormsModule, TranslateModule],
    templateUrl: './scene-folder-picker.component.html',
    styleUrl: './scene-folder-picker.component.css',
    host: {class: 'flex flex-col gap-1.5'},
})
export class SceneFolderPickerComponent {
    readonly guildId = input.required<string>();
    readonly selected = input<string | null>(null);
    /** Null is unfiled. */
    readonly picked = output<string | null>();

    private readonly taxonomy = inject(SceneTaxonomyService);

    protected readonly folderQuery = signal('');

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            untracked(() => this.taxonomy.ensureGuild(guildId));
        });
    }

    private readonly folders = computed(() => this.taxonomy.folders(this.guildId()));

    /** Every parent in order, each followed by its own children. */
    private readonly folderRows = computed<FolderRow[]>(() => {
        const all = this.folders();
        const rows: FolderRow[] = [];
        const placed = new Set<string>();

        for (const parent of all.filter(f => !f.parentFolderId)) {
            rows.push({folder: parent, child: false, parentName: null});
            placed.add(parent.id);
            for (const child of all.filter(f => f.parentFolderId === parent.id)) {
                rows.push({folder: child, child: true, parentName: parent.name});
                placed.add(child.id);
            }
        }

        // A folder whose parent is not in the local copy would otherwise drop out of the picker.
        for (const folder of all) {
            if (!placed.has(folder.id)) rows.push({folder, child: false, parentName: null});
        }
        return rows;
    });

    protected readonly folderMatches = computed(() => {
        const query = this.folderQuery().trim().toLowerCase();
        if (!query) return this.folderRows();
        return this.folderRows().filter(
            row =>
                row.folder.name.toLowerCase().includes(query) ||
                !!row.parentName?.toLowerCase().includes(query),
        );
    });

    protected readonly searching = computed(() => !!this.folderQuery().trim());

    protected choose(folderId: string | null): void {
        this.folderQuery.set('');
        this.picked.emit(folderId);
    }
}
