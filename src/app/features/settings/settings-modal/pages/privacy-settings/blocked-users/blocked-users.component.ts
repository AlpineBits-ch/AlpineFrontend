import {Component, inject, OnInit, signal} from '@angular/core';
import {DatePipe} from '@angular/common';
import {Button} from 'primeng/button';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {BlockedUserDto, RelationshipService} from '../../../../../../services/relationship.service';
import {ToastService} from '../../../../../../services/toast.service';

/** The account's block list. */
@Component({
    selector: 'app-blocked-users',
    imports: [Button, DatePipe, TranslateModule],
    templateUrl: './blocked-users.component.html',
})
export class BlockedUsersComponent implements OnInit {
    private readonly relationships = inject(RelationshipService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly blocked = signal<BlockedUserDto[]>([]);
    protected readonly loading = signal(false);
    protected readonly failed = signal(false);
    protected readonly nextCursor = signal<string | null>(null);
    /** Ids with an unblock in flight, so the row's button can spin without freezing the list. */
    protected readonly pending = signal<ReadonlySet<string>>(new Set());

    ngOnInit(): void {
        this.load();
    }

    protected load(cursor: string | null = null): void {
        this.loading.set(true);
        this.failed.set(false);
        this.relationships.getBlockedUsers(cursor).subscribe({
            next: page => {
                this.blocked.update(current => cursor ? [...current, ...page.blocked] : page.blocked);
                this.nextCursor.set(page.nextCursor);
                this.loading.set(false);
            },
            error: () => {
                this.loading.set(false);
                this.failed.set(true);
            },
        });
    }

    protected loadMore(): void {
        const cursor = this.nextCursor();
        if (cursor) this.load(cursor);
    }

    protected isPending(userId: string): boolean {
        return this.pending().has(userId);
    }

    protected unblock(entry: BlockedUserDto): void {
        // The Identity user id, not the relationship row - the block endpoints are keyed on the
        // person, which is what makes unblocking idempotent after the row has already gone.
        const userId = entry.userId;
        if (this.isPending(userId)) return;
        this.markPending(userId, true);

        this.relationships.unblockUser(userId).subscribe({
            next: () => {
                this.blocked.update(list => list.filter(b => b.userId !== userId));
                this.markPending(userId, false);
                this.toast.success(
                    this.translate.instant('SETTINGS.PRIVACY.UNBLOCK_SUCCESS', {name: entry.userName}),
                );
            },
            error: () => {
                this.markPending(userId, false);
                this.toast.error(this.translate.instant('SETTINGS.PRIVACY.UNBLOCK_ERROR'));
            },
        });
    }

    private markPending(userId: string, active: boolean): void {
        const next = new Set(this.pending());
        if (active) next.add(userId); else next.delete(userId);
        this.pending.set(next);
    }
}
