import {buildAskQuestion, citedPageIds, splitAnswer} from './wiki-ai-answer';
import {rankAskSources} from './wiki-ai-shared';

describe('splitAnswer', () => {
    it('returns one text segment when there are no citations', () => {
        expect(splitAnswer('Nothing to cite here.')).toEqual([
            {text: 'Nothing to cite here.', pageId: null},
        ]);
    });

    it('splits a citation out of the surrounding prose', () => {
        expect(splitAnswer('See [Onboarding](wiki:p1) first.')).toEqual([
            {text: 'See ', pageId: null},
            {text: 'Onboarding', pageId: 'p1'},
            {text: ' first.', pageId: null},
        ]);
    });

    it('handles an answer that is only a citation', () => {
        expect(splitAnswer('[Runbook](wiki:p9)')).toEqual([{text: 'Runbook', pageId: 'p9'}]);
    });

    // An ordinary external link is not a citation, and rendering it as one would produce a button that navigates to a page id that does not exist.
    it('leaves non-wiki links alone', () => {
        expect(splitAnswer('See [docs](https://example.com).')).toEqual([
            {text: 'See [docs](https://example.com).', pageId: null},
        ]);
    });

    // The answer is rendered while it streams, so half a citation is a state that really occurs.
    it('treats an unfinished citation as text', () => {
        expect(splitAnswer('See [Onboar')).toEqual([{text: 'See [Onboar', pageId: null}]);
    });

    it('collects cited ids in first-mention order without repeats', () => {
        const answer = '[A](wiki:p1) then [B](wiki:p2) then [A again](wiki:p1)';
        expect(citedPageIds(answer)).toEqual(['p1', 'p2']);
    });
});

describe('buildAskQuestion', () => {
    it('sends the question alone when there is no history', () => {
        expect(buildAskQuestion([], 'What is on-call?')).toBe('What is on-call?');
    });

    it('carries earlier turns so a follow-up has a referent', () => {
        const built = buildAskQuestion(
            [{question: 'Who owns billing?', answer: 'The payments team.'}],
            'And support?',
        );
        expect(built).toContain('Who owns billing?');
        expect(built).toContain('The payments team.');
        expect(built).toContain('And support?');
    });

    // A turn that failed or was stopped has no answer; including it would present the model with a question it is being told it already answered, and no answer.
    it('drops turns with no answer', () => {
        const built = buildAskQuestion([{question: 'Stopped one', answer: '   '}], 'Next?');
        expect(built).toBe('Next?');
    });

    it('keeps only the most recent turns', () => {
        const history = [1, 2, 3, 4, 5].map(n => ({question: `q${n}`, answer: `a${n}`}));
        const built = buildAskQuestion(history, 'now', 2);
        expect(built).not.toContain('q3');
        expect(built).toContain('q4');
        expect(built).toContain('q5');
    });
});

describe('rankAskSources', () => {
    const sources = [
        {id: 'a', title: 'Deployment', content: 'How releases go out.'},
        {id: 'b', title: 'Holidays', content: 'Time off policy.'},
        {id: 'c', title: 'Runbook', content: 'Steps for a failed deployment.'},
    ];

    it('puts a title match first and a body match second', () => {
        expect(rankAskSources(sources, 'deployment').map(s => s.id)).toEqual(['a', 'c', 'b']);
    });

    // The trimming happens in the provider layer, which prefers whole pages; truncating here would both truncate twice and defeat that preference.
    it('never alters the sources it ranks', () => {
        expect(rankAskSources(sources, 'deployment')).toEqual(expect.arrayContaining(sources));
    });

    it('keeps every candidate even when nothing matches', () => {
        expect(rankAskSources(sources, 'zzz').length).toBe(3);
    });
});
