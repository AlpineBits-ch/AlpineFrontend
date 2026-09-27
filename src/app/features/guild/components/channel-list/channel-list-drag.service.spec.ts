import {TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {of} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ChannelListDragService} from './channel-list-drag.service';
import {GuildService} from '../../../../services/guild.service';
import {CategoryDto, ChannelDto} from '../../../../dtos/response/guild.dto';
import {ReorderChannesDto} from '../../../../dtos/request/reorder-channel.dto';

const channel = (id: string, position: number, categoryId?: string) =>
    ({id, position, categoryId}) as unknown as ChannelDto;
const category = (id: string, position: number) => ({id, position}) as unknown as CategoryDto;

// The drag handlers only read these; jsdom has no DragEvent constructor.
const dragEvent = (clientY = 100) =>
    ({
        preventDefault: () => undefined,
        dataTransfer: null,
        clientY,
        currentTarget: {getBoundingClientRect: () => ({top: 0, height: 10})},
    }) as unknown as DragEvent;

describe('ChannelListDragService', () => {
    let service: ChannelListDragService;
    let reorderChannels: ReturnType<typeof vi.fn>;
    const channels = signal<ChannelDto[]>([]);
    const categories = signal<CategoryDto[]>([]);

    beforeEach(() => {
        reorderChannels = vi.fn(() => of(undefined));
        TestBed.configureTestingModule({
            providers: [ChannelListDragService, {provide: GuildService, useValue: {reorderChannels}}],
        });
        service = TestBed.inject(ChannelListDragService);
        channels.set([
            channel('a', 0, 'cat'),
            channel('b', 1, 'cat'),
            channel('c', 2, 'cat'),
            channel('x', 0),
        ]);
        categories.set([category('cat', 0)]);
        service.setup(() => 'g1', channels, categories);
    });

    const sent = (): ReorderChannesDto => reorderChannels.mock.calls[0][1];

    it('keeps every sibling in its category when reordering within it', () => {
        service.onChannelDragStart(dragEvent(), channels()[2]);
        service.onItemDragOver(dragEvent(0), 'a');
        service.onDragEnd(dragEvent());

        expect(sent().channels).toEqual([
            {channelId: 'c', position: 0, categoryId: 'cat'},
            {channelId: 'a', position: 1, categoryId: 'cat'},
            {channelId: 'b', position: 2, categoryId: 'cat'},
        ]);
    });

    it('sends the category for every channel when one is dropped among them', () => {
        service.onChannelDragStart(dragEvent(), channels()[3]);
        service.onItemDragOver(dragEvent(100), 'a');
        service.onDragEnd(dragEvent());

        expect(sent().channels).toEqual([
            {channelId: 'a', position: 0, categoryId: 'cat'},
            {channelId: 'x', position: 1, categoryId: 'cat'},
            {channelId: 'b', position: 2, categoryId: 'cat'},
            {channelId: 'c', position: 3, categoryId: 'cat'},
        ]);
    });

    it('sends the category for every channel when one is dropped on the header', () => {
        service.onChannelDragStart(dragEvent(), channels()[3]);
        service.onItemDragOver(dragEvent(100), 'cat');
        service.onDragEnd(dragEvent());

        expect(sent().channels.map(c => c.categoryId)).toEqual(['cat', 'cat', 'cat', 'cat']);
        expect(sent().channels.map(c => c.channelId)).toEqual(['a', 'b', 'c', 'x']);
    });

    it('sends null for every uncategorized channel', () => {
        service.onChannelDragStart(dragEvent(), channels()[0]);
        service.onItemDragOver(dragEvent(0), 'cat');
        service.onDragEnd(dragEvent());

        expect(sent().channels).toEqual([
            {channelId: 'x', position: 0, categoryId: null},
            {channelId: 'a', position: 1, categoryId: null},
        ]);
    });
});
