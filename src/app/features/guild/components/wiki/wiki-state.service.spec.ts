import {describe, expect, it} from 'vitest';
import {WikiPageDto, WikiPageSummaryDto} from '../../../../dtos/response/wiki.dto';
import {mergeSummary} from './wiki-state.service';

const CREATED = new Date('2026-08-01T00:00:00Z');
const UPDATED = new Date('2026-08-01T00:00:00Z');

function page(over: Partial<WikiPageDto> = {}): WikiPageDto {
    return {
        id: 'p1',
        guildId: 'g1',
        title: 'Deploys',
        slug: 'deploys',
        content: '## How we ship',
        authorId: 'u1',
        lastEditorId: 'u1',
        tags: [],
        isPinned: false,
        visibility: 'public',
        revisionCount: 2,
        createdAt: CREATED,
        updatedAt: UPDATED,
        ...over,
    };
}

function summary(over: Partial<WikiPageSummaryDto> = {}): WikiPageSummaryDto {
    return {
        id: 'p1',
        guildId: 'g1',
        title: 'Deploys',
        slug: 'deploys',
        authorId: 'u1',
        tags: [],
        isPinned: false,
        visibility: 'public',
        revisionCount: 2,
        createdAt: CREATED,
        updatedAt: UPDATED,
        ...over,
    };
}

describe('mergeSummary', () => {
    // The regression this exists for: the wiki listing omits `content` unless explicitly asked,
    // so spreading a summary wholesale blanked the open page the moment a save triggered a
    // second load. It looked like the save had wiped the body, and a reload "fixed" it.
    it('keeps the loaded body when the summary carries no content', () => {
        expect(mergeSummary(page(), summary()).content).toBe('## How we ship');
    });

    it('keeps the loaded body even when the summary sets content to undefined', () => {
        expect(mergeSummary(page(), summary({content: undefined})).content).toBe('## How we ship');
    });

    // The listing is authoritative for metadata - that is the entire reason for merging at all.
    it('takes refreshed metadata from the summary', () => {
        const later = new Date('2026-08-05T12:00:00Z');
        const merged = mergeSummary(page(), summary({
            title: 'Deployments',
            isPinned: true,
            revisionCount: 7,
            updatedAt: later,
        }));
        expect(merged.title).toBe('Deployments');
        expect(merged.isPinned).toBe(true);
        expect(merged.revisionCount).toBe(7);
        expect(merged.updatedAt).toBe(later);
    });

    it('keeps fields the summary does not carry', () => {
        expect(mergeSummary(page(), summary({lastEditorId: undefined})).authorId).toBe('u1');
    });

    it('does not mutate either input', () => {
        const original = page();
        mergeSummary(original, summary({title: 'Changed'}));
        expect(original.title).toBe('Deploys');
    });

    // A warmed listing does carry content, and it is the same value the page already holds -
    // so ignoring it costs nothing and keeps one rule rather than two.
    it('still prefers the loaded body when the summary was warmed with content', () => {
        expect(mergeSummary(page(), summary({content: '## How we ship'})).content)
            .toBe('## How we ship');
    });
});
