import {inject, Injectable, signal, WritableSignal} from '@angular/core';
import {CategoryDto, ChannelDto} from '../../../../dtos/response/guild.dto';
import {GuildService} from '../../../../services/guild.service';

interface DraggingState {
    type: 'category' | 'channel';
    id: string;
    sourceCategoryId: string | null;
}

@Injectable()
export class ChannelListDragService {
    readonly dropTargetId = signal<string | null>(null);
    readonly dropPos = signal<'before' | 'after'>('after');
    private guildService = inject(GuildService);
    private guildId!: () => string;
    private localChannels!: WritableSignal<ChannelDto[]>;
    private localCategories!: WritableSignal<CategoryDto[]>;
    private dragging: DraggingState | null = null;

    setup(
        guildId: () => string,
        channels: WritableSignal<ChannelDto[]>,
        categories: WritableSignal<CategoryDto[]>,
    ): void {
        this.guildId = guildId;
        this.localChannels = channels;
        this.localCategories = categories;
    }

    // ── Global drag handlers (WebView2 requires dropEffect on every event) ──────

    onGlobalDragOver(event: DragEvent): void {
        if (!this.dragging) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    }

    onGlobalDragEnter(event: DragEvent): void {
        if (!this.dragging) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    }

    onGlobalDrop(event: DragEvent): void {
        event.preventDefault();
    }

    // ── Drag start ──────────────────────────────────────────────────────────────

    onCategoryDragStart(event: DragEvent, category: CategoryDto): void {
        this.dragging = {type: 'category', id: category.id, sourceCategoryId: null};
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', category.id);
        }
    }

    onChannelDragStart(event: DragEvent, channel: ChannelDto): void {
        this.dragging = {type: 'channel', id: channel.id, sourceCategoryId: channel.categoryId ?? null};
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', channel.id);
        }
    }

    // ── Drag over item (sets indicator position) ────────────────────────────────

    onItemDragOver(event: DragEvent, targetId: string): void {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        if (!this.dragging || this.dragging.id === targetId) return;
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        this.dropTargetId.set(targetId);
        this.dropPos.set(event.clientY < rect.top + rect.height / 2 ? 'before' : 'after');
    }

    // ── Drag end (all drop logic lives here, not on the drop event) ─────────────

    onDragEnd(_event: DragEvent): void {
        const dragging = this.dragging;
        const targetId = this.dropTargetId();
        const pos = this.dropPos();
        this.clearDragState();

        if (!dragging || !targetId) return;

        const targetChannel = this.localChannels().find(c => c.id === targetId);
        if (targetChannel) {
            if (dragging.type !== 'channel' || dragging.id === targetChannel.id) return;
            const targetCategoryId = targetChannel.categoryId ?? null;
            const categoryChanged = dragging.sourceCategoryId !== targetCategoryId;
            if (categoryChanged) {
                this.localChannels.update(chs =>
                    chs.map(c => c.id === dragging.id ? {...c, categoryId: targetCategoryId ?? undefined} : c)
                );
            }
            this.reorderChannelsInSection(
                dragging.id, targetCategoryId, targetChannel.id, pos,
                categoryChanged ? targetCategoryId : undefined,
            );
            return;
        }

        const targetCategory = this.localCategories().find(c => c.id === targetId);
        if (!targetCategory) return;

        if (dragging.type === 'category' && dragging.id !== targetCategory.id) {
            this.reorderCategoryAfterDrop(dragging.id, targetCategory.id, pos);
        } else if (dragging.type === 'channel') {
            if (pos === 'before') {
                // Line before a category header = move channel to uncategorized section
                if (dragging.sourceCategoryId !== null) {
                    this.localChannels.update(chs =>
                        chs.map(c => c.id === dragging.id ? {...c, categoryId: undefined} : c)
                    );
                    this.appendChannelToSection(dragging.id, null, null);
                }
            } else if (dragging.sourceCategoryId !== targetCategory.id) {
                // Line after/on a category header = move channel into that category
                this.localChannels.update(chs =>
                    chs.map(c => c.id === dragging.id ? {...c, categoryId: targetCategory.id} : c)
                );
                this.appendChannelToSection(dragging.id, targetCategory.id, targetCategory.id);
            }
        }
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private sortedCategories(): CategoryDto[] {
        return [...this.localCategories()].sort((a, b) => a.position - b.position);
    }

    private categoryChannels(categoryId: string): ChannelDto[] {
        return this.localChannels()
            .filter(c => c.categoryId === categoryId)
            .sort((a, b) => a.position - b.position);
    }

    private uncategorizedChannels(): ChannelDto[] {
        return this.localChannels()
            .filter(c => !c.categoryId)
            .sort((a, b) => a.position - b.position);
    }

    private reorderChannelsInSection(
        draggedId: string,
        categoryId: string | null,
        targetId: string,
        pos: 'before' | 'after',
        newCategoryId?: string | null,
    ): void {
        const sectionChannels = categoryId
            ? this.categoryChannels(categoryId)
            : this.uncategorizedChannels();

        const dragged = this.localChannels().find(c => c.id === draggedId);
        if (!dragged) return;

        const sorted = sectionChannels.filter(c => c.id !== draggedId);
        const targetIndex = sorted.findIndex(c => c.id === targetId);
        const insertAt = targetIndex === -1
            ? sorted.length
            : pos === 'before' ? targetIndex : targetIndex + 1;
        sorted.splice(insertAt, 0, dragged);

        const newPositions = new Map(sorted.map((c, i) => [c.id, i]));
        this.localChannels.update(chs =>
            chs.map(c => newPositions.has(c.id) ? {...c, position: newPositions.get(c.id)!} : c)
        );

        this.guildService.reorderChannels(this.guildId(), {
            categories: [],
            channels: sorted.map((c, i) => ({
                channelId: c.id,
                position: i,
                ...(c.id === draggedId && newCategoryId !== undefined ? {categoryId: newCategoryId} : {}),
            })),
        }).subscribe();
    }

    private appendChannelToSection(channelId: string, categoryId: string | null, newCategoryId?: string | null): void {
        const sectionChannels = categoryId
            ? this.categoryChannels(categoryId)
            : this.uncategorizedChannels();

        const dragged = this.localChannels().find(c => c.id === channelId);
        if (!dragged) return;

        const sorted = [...sectionChannels.filter(c => c.id !== channelId), dragged];
        const newPositions = new Map(sorted.map((c, i) => [c.id, i]));
        this.localChannels.update(chs =>
            chs.map(c => newPositions.has(c.id) ? {...c, position: newPositions.get(c.id)!} : c)
        );

        this.guildService.reorderChannels(this.guildId(), {
            categories: [],
            channels: sorted.map((c, i) => ({
                channelId: c.id,
                position: i,
                ...(c.id === channelId && newCategoryId !== undefined ? {categoryId: newCategoryId} : {}),
            })),
        }).subscribe();
    }

    private reorderCategoryAfterDrop(draggedId: string, targetId: string, pos: 'before' | 'after'): void {
        const sorted = this.sortedCategories();
        const fromIndex = sorted.findIndex(c => c.id === draggedId);
        if (fromIndex === -1) return;

        const [dragged] = sorted.splice(fromIndex, 1);
        const newTargetIndex = sorted.findIndex(c => c.id === targetId);
        if (newTargetIndex === -1) return;

        sorted.splice(pos === 'before' ? newTargetIndex : newTargetIndex + 1, 0, dragged);

        const newPositions = new Map(sorted.map((c, i) => [c.id, i]));
        this.localCategories.update(cats =>
            cats.map(c => newPositions.has(c.id) ? {...c, position: newPositions.get(c.id)!} : c)
        );

        this.guildService.reorderChannels(this.guildId(), {
            categories: sorted.map((c, i) => ({categoryId: c.id, position: i})),
            channels: [],
        }).subscribe();
    }

    private clearDragState(): void {
        this.dragging = null;
        this.dropTargetId.set(null);
        this.dropPos.set('after');
    }
}
