import {TestBed} from '@angular/core/testing';
import {of, Subject, throwError} from 'rxjs';
import {WikiContentCacheService} from './wiki-content-cache.service';
import {WikiService} from '../../../../services/wiki.service';

function wikiWith(pages: {id: string; content?: string}[]) {
    return {id: 'w', guildId: 'g1', categories: [], pages} as never;
}

describe('WikiContentCacheService', () => {
    let service: WikiContentCacheService;
    let getWikiWithContent: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        getWikiWithContent = vi.fn(() =>
            of(
                wikiWith([
                    {id: 'p1', content: 'body one'},
                    {id: 'p2', content: 'body two'},
                ]),
            ),
        );
        TestBed.configureTestingModule({
            providers: [{provide: WikiService, useValue: {getWikiWithContent}}],
        });
        service = TestBed.inject(WikiContentCacheService);
    });

    it('starts empty, not warming and not warmed', () => {
        expect(service.content().size).toBe(0);
        expect(service.warming()).toBe(false);
        expect(service.warmed()).toBe(false);
    });

    it('stores content put into it directly as pages are opened', () => {
        service.put('p1', 'hello');
        expect(service.content().get('p1')).toBe('hello');
    });

    // One request for the whole wiki, not one per page.
    it('fills every page from a single request', () => {
        service.warm('g1');
        expect(getWikiWithContent).toHaveBeenCalledTimes(1);
        expect(getWikiWithContent).toHaveBeenCalledWith('g1');
        expect(service.content().get('p2')).toBe('body two');
        expect(service.warmed()).toBe(true);
    });

    it('clears warming once the request settles', () => {
        service.warm('g1');
        expect(service.warming()).toBe(false);
    });

    // An empty string is a truthful "nothing to search here", so it counts as warm.
    it('warms on a page whose body really is empty', () => {
        getWikiWithContent.mockReturnValue(of(wikiWith([{id: 'p1', content: ''}])));
        service.warm('g1');
        expect(service.content().get('p1')).toBe('');
        expect(service.warmed()).toBe(true);
        expect(service.failed()).toBe(false);
    });

    // Without this, a response carrying no content field at all reads as a fully indexed wiki of
    // empty pages: search finds nothing and the graph draws no links, both while claiming coverage.
    it('treats a response with no content field on any page as a failed warm', () => {
        getWikiWithContent.mockReturnValue(of(wikiWith([{id: 'p1'}, {id: 'p2'}])));
        service.warm('g1');
        expect(service.warmed()).toBe(false);
        expect(service.failed()).toBe(true);
        expect(service.content().size).toBe(0);
    });

    // The server omits content for a single page it could not read; that one is empty, the rest
    // of the warm still counts.
    it('stores an empty body for one page returned without content among others', () => {
        getWikiWithContent.mockReturnValue(of(wikiWith([{id: 'p1'}, {id: 'p2', content: 'body'}])));
        service.warm('g1');
        expect(service.content().get('p1')).toBe('');
        expect(service.warmed()).toBe(true);
    });

    it('counts a wiki with no pages at all as warmed', () => {
        getWikiWithContent.mockReturnValue(of(wikiWith([])));
        service.warm('g1');
        expect(service.warmed()).toBe(true);
        expect(service.failed()).toBe(false);
    });

    // A failed warm must not look like a completed one, or search silently reports title-only
    // results while presenting itself as full-text.
    it('records a failure and does not claim to be warmed', () => {
        getWikiWithContent.mockReturnValue(throwError(() => new Error('boom')));
        service.warm('g1');
        expect(service.warming()).toBe(false);
        expect(service.warmed()).toBe(false);
        expect(service.failed()).toBe(true);
    });

    it('allows a retry after a failure', () => {
        getWikiWithContent.mockReturnValueOnce(throwError(() => new Error('boom')));
        service.warm('g1');
        service.warm('g1');
        expect(getWikiWithContent).toHaveBeenCalledTimes(2);
        expect(service.warmed()).toBe(true);
        expect(service.failed()).toBe(false);
    });

    it('drops an invalidated page so it is fetched again', () => {
        service.put('p1', 'stale');
        service.invalidate('p1');
        expect(service.content().has('p1')).toBe(false);
    });

    it('empties everything on reset', () => {
        service.warm('g1');
        service.reset();
        expect(service.content().size).toBe(0);
        expect(service.warmed()).toBe(false);
    });

    it('does not warm twice once it has succeeded', () => {
        service.warm('g1');
        service.warm('g1');
        expect(getWikiWithContent).toHaveBeenCalledTimes(1);
    });

    it('ignores a second warm while one is in flight', () => {
        getWikiWithContent.mockReturnValue(new Subject<never>());
        service.warm('g1');
        service.warm('g1');
        expect(getWikiWithContent).toHaveBeenCalledTimes(1);
    });
});
