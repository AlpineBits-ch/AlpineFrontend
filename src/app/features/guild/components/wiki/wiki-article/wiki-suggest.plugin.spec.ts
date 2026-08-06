import {matchTrigger} from './wiki-suggest.plugin';

describe('matchTrigger', () => {
    it('matches a slash at the start of a block', () => {
        expect(matchTrigger('/')).toEqual({trigger: '/', query: '', from: 0});
    });

    it('captures the query typed after a slash', () => {
        expect(matchTrigger('/tab')).toEqual({trigger: '/', query: 'tab', from: 0});
    });

    // The whole point of the mid-line rule: you should not have to start a fresh paragraph to
    // reach the block menu.
    it('matches a slash that opens a word mid-line', () => {
        expect(matchTrigger('see this /tab')).toEqual({trigger: '/', query: 'tab', from: 9});
    });

    it('reports the offset of the slash, not of the block', () => {
        expect(matchTrigger('a /')).toEqual({trigger: '/', query: '', from: 2});
    });

    // Otherwise typing "and/or" mid-sentence opens the block menu.
    it('ignores a slash glued to the preceding word', () => {
        expect(matchTrigger('and/or')).toBeNull();
    });

    it('ignores the slashes in a URL', () => {
        expect(matchTrigger('see https://')).toBeNull();
    });

    it('closes the slash menu once a space is typed', () => {
        expect(matchTrigger('/tab le')).toBeNull();
    });

    it('matches a double bracket anywhere in a line', () => {
        expect(matchTrigger('see [[')).toEqual({trigger: '[[', query: '', from: 4});
    });

    it('captures the query typed after a double bracket, spaces included', () => {
        // Page titles contain spaces, so unlike the slash menu this query must not stop at one.
        expect(matchTrigger('see [[Getting star')).toEqual({
            trigger: '[[', query: 'Getting star', from: 4,
        });
    });

    it('closes the bracket menu once the link is closed', () => {
        expect(matchTrigger('see [[Setup]]')).toBeNull();
    });

    it('ignores a single bracket', () => {
        expect(matchTrigger('see [Setup')).toBeNull();
    });

    // An open page-title query owns the rest of the line; a slash inside it is a title character.
    it('keeps an open bracket ahead of the other triggers', () => {
        expect(matchTrigger('[[Ops /run')).toEqual({trigger: '[[', query: 'Ops /run', from: 0});
    });

    it('matches nothing in plain text', () => {
        expect(matchTrigger('hello world')).toBeNull();
    });

    it('matches nothing in an empty block', () => {
        expect(matchTrigger('')).toBeNull();
    });

    describe('emoji', () => {
        it('waits for two query characters before opening', () => {
            expect(matchTrigger(':')).toBeNull();
            expect(matchTrigger(':s')).toBeNull();
        });

        it('matches a colon shortcode of two characters or more', () => {
            expect(matchTrigger('nice :sm')).toEqual({trigger: ':', query: 'sm', from: 5});
        });

        // "Note: a thing" and "12:30" are prose, not shortcodes.
        it('ignores a colon glued to the preceding word', () => {
            expect(matchTrigger('Note:th')).toBeNull();
            expect(matchTrigger('12:30')).toBeNull();
        });

        it('closes once the shortcode is completed', () => {
            expect(matchTrigger('done :smile:')).toBeNull();
        });

        it('closes once a space is typed', () => {
            expect(matchTrigger(':sm ile')).toBeNull();
        });
    });

    describe('mention', () => {
        it('opens on a bare at-sign, so the member list is reachable with no query', () => {
            expect(matchTrigger('cc @')).toEqual({trigger: '@', query: '', from: 3});
        });

        it('captures the typed name', () => {
            expect(matchTrigger('@ali')).toEqual({trigger: '@', query: 'ali', from: 0});
        });

        // Email addresses would otherwise open the member list on every domain typed.
        it('ignores an at-sign glued to the preceding word', () => {
            expect(matchTrigger('me@example')).toBeNull();
        });

        it('closes once a space is typed', () => {
            expect(matchTrigger('@ali ce')).toBeNull();
        });
    });
});
