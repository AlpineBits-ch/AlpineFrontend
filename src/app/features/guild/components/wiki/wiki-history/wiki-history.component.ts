import {Component, computed, effect, inject, input, output, signal} from '@angular/core';
import {NgTemplateOutlet} from '@angular/common';
import {Button} from 'primeng/button';
import {Tooltip} from 'primeng/tooltip';
import {TranslateModule} from '@ngx-translate/core';
import {WikiPageDto, WikiRevisionDto} from '../../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../../services/wiki.service';
import {ProfileService} from '../../../../../services/profile.service';
import {AppAvatarComponent} from '../../../../../components/avatar/avatar.component';
import {formatWikiDate} from '../wiki.utils';
import {WikiStateService} from '../wiki-state.service';
import {DiffLine, diffLines, diffStat} from '../wiki-diff';
import {groupRevisionsByDay, SideBySideRow, toSideBySide} from './wiki-history-view';

export type DiffLayout = 'unified' | 'split';

@Component({
    selector: 'app-wiki-history',
    imports: [Button, Tooltip, TranslateModule, AppAvatarComponent, NgTemplateOutlet],
    templateUrl: './wiki-history.component.html',
})
export class WikiHistoryComponent {
    readonly page = input.required<WikiPageDto>();
    readonly guildId = input.required<string>();

    readonly back = output<void>();
    readonly restored = output<WikiPageDto>();

    protected readonly revisions = signal<WikiRevisionDto[]>([]);
    protected readonly loading = signal(false);
    protected readonly restoringId = signal<string | null>(null);
    protected readonly expandedRevId = signal<string | null>(null);
    protected readonly compareMode = signal<'previous' | 'current'>('previous');
    protected readonly layout = signal<DiffLayout>('unified');
    /** The two revisions being compared, in click order; empty or one entry means the list is in its ordinary per-revision mode. */
    protected readonly selection = signal<string[]>([]);

    protected readonly state = inject(WikiStateService);
    protected readonly formatDate = formatWikiDate;

    protected readonly groups = computed(() => groupRevisionsByDay(this.revisions()));
    /** Revisions arrive newest first, so the head is what the page currently says. */
    protected readonly currentRevisionId = computed(() => this.revisions()[0]?.id ?? null);

    /** An arbitrary pair of revisions being compared. */
    protected readonly comparison = computed(() => {
        const ids = this.selection();
        if (ids.length !== 2) return null;
        const all = this.revisions();
        const picked = ids
            .map(id => all.find(revision => revision.id === id))
            .filter((revision): revision is WikiRevisionDto => !!revision);
        if (picked.length !== 2) return null;

        // Always oldest to newest, whatever order they were clicked in: a diff that reads backwards in time is technically a diff and practically a trap.
        const [from, to] = [...picked].sort((a, b) => a.revisionNumber - b.revisionNumber);
        const lines = diffLines(from.content ?? '', to.content ?? '');
        return {from, to, lines, stat: diffStat(lines)};
    });

    private readonly wikiService = inject(WikiService);
    private readonly profileService = inject(ProfileService);
    /** Diffs are O(n*m); memoized keyed by compare mode and revision id, and cleared whenever the revisions are replaced. */
    private diffMemo = new Map<string, DiffLine[]>();

    constructor() {
        effect(() => {
            const page = this.page();
            this.loading.set(true);
            this.revisions.set([]);
            this.selection.set([]);
            this.diffMemo.clear();
            this.wikiService.getRevisions(this.guildId(), page.id).subscribe({
                next: revisions => {
                    this.revisions.set(revisions);
                    this.diffMemo.clear();
                    this.loading.set(false);
                },
                error: () => this.loading.set(false),
            });
        });

        // Resolves editors through ProfileService (not the member list) to reuse the cache `app-avatar` already reads from.
        effect(() => {
            for (const revision of this.revisions()) {
                if (revision.editorId) this.profileService.resolveByUserId(revision.editorId);
            }
        });
    }

    /** Undefined rather than the id: a raw uuid beside an avatar is noise, not attribution. */
    protected editorName(revision: WikiRevisionDto): string | undefined {
        return revision.editorId
            ? this.profileService.getCachedByUserId(revision.editorId)?.userName
            : undefined;
    }

    protected togglePreview(revId: string): void {
        this.expandedRevId.update(id => (id === revId ? null : revId));
    }

    protected isSelected(revId: string): boolean {
        return this.selection().includes(revId);
    }

    protected toggleSelection(revId: string): void {
        this.selection.update(ids => {
            if (ids.includes(revId)) return ids.filter(id => id !== revId);
            // A third pick replaces the older half of the pair rather than being refused: a click that does nothing reads as a broken control.
            return ids.length >= 2 ? [ids[ids.length - 1], revId] : [...ids, revId];
        });
    }

    protected clearSelection(): void {
        this.selection.set([]);
    }

    /** Revisions arrive newest first, so a revision's predecessor is the *next* element, not the previous one; the wrong neighbour inverts every diff without erroring. */
    protected diffFor(revision: WikiRevisionDto): DiffLine[] {
        const mode = this.compareMode();
        const key = `${mode}:${revision.id}`;
        const memoized = this.diffMemo.get(key);
        if (memoized) return memoized;

        const all = this.revisions();
        const index = all.findIndex(r => r.id === revision.id);
        const before = mode === 'current' ? revision.content : (all[index + 1]?.content ?? '');
        const after = mode === 'current' ? this.page().content : revision.content;
        const lines = diffLines(before ?? '', after ?? '');
        this.diffMemo.set(key, lines);
        return lines;
    }

    protected statFor(revision: WikiRevisionDto): {added: number; removed: number} {
        return diffStat(this.diffFor(revision));
    }

    protected toSplit(lines: readonly DiffLine[]): SideBySideRow[] {
        return toSideBySide(lines);
    }

    protected formatTime(date: Date | string): string {
        return new Date(date).toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'});
    }

    protected restoreRevision(revision: WikiRevisionDto): void {
        this.restoringId.set(revision.id);
        this.wikiService.restoreRevision(this.guildId(), this.page().id, revision.id).subscribe({
            next: page => {
                this.restoringId.set(null);
                this.restored.emit(page);
            },
            error: () => this.restoringId.set(null),
        });
    }
}
