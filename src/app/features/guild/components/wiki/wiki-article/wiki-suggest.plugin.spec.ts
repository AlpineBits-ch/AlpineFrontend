import {matchTrigger} from './wiki-suggest.plugin';

describe('matchTrigger', () => {
    it('matches a slash at the start of a block', () => {
        expect(matchTrigger('/')).toEqual({trigger: '/', query: '', from: 0});
    });

    it('captures the query typed after a slash', () => {
        expect(matchTrigger('/tab')).toEqual({trigger: '/', query: 'tab', from: 0});
    });

    // Otherwise typing a URL or "and/or" mid-sentence opens the block menu.
    it('ignores a slash that follows other text', () => {
        expect(matchTrigger('and/or')).toBeNull();
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

    it('matches nothing in plain text', () => {
        expect(matchTrigger('hello world')).toBeNull();
    });

    it('matches nothing in an empty block', () => {
        expect(matchTrigger('')).toBeNull();
    });
});
