import {
    AI_METADATA_MAX_TAGS,
    AiAskSource,
    AiResponseFormatError,
    ASK_SOURCE_BUDGET,
    buildAskPrompt,
    buildCompletePrompt,
    buildMetadataPrompt,
    buildTransformPrompt,
    COMPLETE_MAX_CHARS,
    parseAiMetadata,
    pickFastModel,
    sanitizeCompletion,
    shouldSkipCompletion,
    stripOuterFence,
    trimAskSources,
} from './ai-provider';

function source(id: string, title: string, length: number): AiAskSource {
    return {id, title, content: 'x'.repeat(length)};
}

describe('buildTransformPrompt', () => {
    const base = {text: 'The pipeline runs nightly.', title: 'Runbook', pageTitles: []} as const;

    it('ends with the passage, so the model has nothing to continue but the text', () => {
        const prompt = buildTransformPrompt({...base, op: 'improve'});
        expect(prompt.endsWith(base.text)).toBe(true);
    });

    it('carries the instruction for the op it was given', () => {
        expect(buildTransformPrompt({...base, op: 'shorten'})).toContain('shorter');
        expect(buildTransformPrompt({...base, op: 'grammar'})).toContain('Fix spelling');
        expect(buildTransformPrompt({...base, op: 'translate'})).toContain('Translate');
    });

    it('keeps the user instruction separate from the op instruction', () => {
        const prompt = buildTransformPrompt({...base, op: 'tone', instruction: 'formal'});
        expect(prompt).toContain('From the user: formal');
    });

    it('omits the user line when there is no instruction, or only whitespace', () => {
        expect(buildTransformPrompt({...base, op: 'improve'})).not.toContain('From the user');
        expect(buildTransformPrompt({...base, op: 'improve', instruction: '  '}))
            .not.toContain('From the user');
    });

    it('omits the page list rather than sending an empty one', () => {
        expect(buildTransformPrompt({...base, op: 'improve'})).not.toContain('Other pages');
        expect(buildTransformPrompt({...base, op: 'improve', pageTitles: ['Deploys', 'Oncall']}))
            .toContain('Other pages in this wiki: Deploys, Oncall');
    });

    it('tells continue not to repeat the passage', () => {
        expect(buildTransformPrompt({...base, op: 'continue'})).toContain('never a repeat');
    });
});

describe('trimAskSources', () => {
    it('keeps everything, untruncated, when it all fits', () => {
        const trimmed = trimAskSources([source('a', 'A', 100), source('b', 'B', 100)], 1000);
        expect(trimmed.sources.map(s => s.id)).toEqual(['a', 'b']);
        expect(trimmed.sources.every(s => !s.truncated)).toBe(true);
        expect(trimmed).toMatchObject({omitted: 0, partial: false});
    });

    it('never exceeds the budget', () => {
        const trimmed = trimAskSources(
            [source('a', 'A', 900), source('b', 'B', 900), source('c', 'C', 900)],
            1000,
        );
        const total = trimmed.sources.reduce((n, s) => n + s.content.length, 0);
        expect(total).toBeLessThanOrEqual(1000);
    });

    it('prefers whole lower-ranked pages over truncating the top one', () => {
        const trimmed = trimAskSources(
            [source('big', 'Big', 1500), source('b', 'B', 400), source('c', 'C', 300)],
            1000,
        );
        // 'big' did not fit; the two that did are whole, and the leftover was too small to be
        // worth a truncated page.
        expect(trimmed.sources.map(s => s.id)).toEqual(['b', 'c']);
        expect(trimmed).toMatchObject({omitted: 1, partial: true});
    });

    it('spends a large leftover on the head of the best page that did not fit', () => {
        const trimmed = trimAskSources(
            [source('big', 'Big', 1500), source('b', 'B', 400), source('c', 'C', 300)],
            1200,
        );
        expect(trimmed.sources.map(s => s.id)).toEqual(['big', 'b', 'c']);
        expect(trimmed.sources[0].truncated).toBe(true);
        expect(trimmed.sources[0].content.length).toBeLessThanOrEqual(500);
        expect(trimmed).toMatchObject({omitted: 0, partial: true});
    });

    it('truncates at most one page', () => {
        const trimmed = trimAskSources(
            [source('a', 'A', 5000), source('b', 'B', 5000), source('c', 'C', 5000)],
            2000,
        );
        expect(trimmed.sources.filter(s => s.truncated)).toHaveLength(1);
        expect(trimmed.omitted).toBe(2);
    });

    it('cuts at a word boundary rather than mid-word', () => {
        const words = ('lorem ipsum dolor '.repeat(200)).trim();
        const trimmed = trimAskSources([{id: 'a', title: 'A', content: words}], 1000);
        expect(trimmed.sources[0].truncated).toBe(true);
        expect(trimmed.sources[0].content.endsWith(' ')).toBe(false);
        expect(words.startsWith(trimmed.sources[0].content)).toBe(true);
    });

    it('handles an empty candidate list', () => {
        expect(trimAskSources([], 1000)).toEqual({sources: [], omitted: 0, partial: false});
    });

    it('defaults to the documented budget', () => {
        const trimmed = trimAskSources([source('a', 'A', ASK_SOURCE_BUDGET + 10_000)]);
        expect(trimmed.sources[0].content.length).toBeLessThanOrEqual(ASK_SOURCE_BUDGET);
    });
});

describe('buildAskPrompt', () => {
    const sources = [
        {id: 'p1', title: 'Runbook', content: 'Deploys happen on Tuesdays.'},
        {id: 'p2', title: 'Oncall', content: 'Page the duty engineer.'},
    ];

    it('gives the model the exact citation link for each source', () => {
        const prompt = buildAskPrompt({question: 'When do we deploy?', sources});
        expect(prompt).toContain('Cite as: [Runbook](wiki:p1)');
        expect(prompt).toContain('Cite as: [Oncall](wiki:p2)');
    });

    it('puts the question last', () => {
        const prompt = buildAskPrompt({question: 'When do we deploy?', sources});
        expect(prompt.endsWith('Question: When do we deploy?')).toBe(true);
    });

    it('says so when there is nothing to answer from, rather than sending a blank section', () => {
        const prompt = buildAskPrompt({question: 'Anything?', sources: []});
        expect(prompt).toContain('No wiki pages were found');
        expect(prompt).not.toContain('Cite as');
    });

    it('warns that the sources are partial when a page was left out', () => {
        const prompt = buildAskPrompt({
            question: 'q',
            sources: [source('a', 'A', 5000), source('b', 'B', 5000)],
        }, 1000);
        expect(prompt).toContain('did not fit');
        expect(prompt).toContain('partial');
    });

    it('marks the truncated page in its own block', () => {
        const prompt = buildAskPrompt({question: 'q', sources: [source('a', 'A', 5000)]}, 2000);
        expect(prompt).toContain('this page is truncated');
    });

    it('says nothing about partial sources when everything fitted', () => {
        const prompt = buildAskPrompt({question: 'q', sources});
        expect(prompt).not.toContain('partial');
    });

    it('labels an empty page instead of leaving a hole between two headers', () => {
        const prompt = buildAskPrompt({question: 'q', sources: [{id: 'a', title: 'A', content: ''}]});
        expect(prompt).toContain('(this page is empty)');
    });
});

describe('shouldSkipCompletion', () => {
    it('skips a context too thin to continue from', () => {
        expect(shouldSkipCompletion({before: 'Hi', after: '', title: 'T'})).toBe(true);
        expect(shouldSkipCompletion({before: '   \n  ', after: '', title: 'T'})).toBe(true);
    });

    it('runs once there is a sentence to build on', () => {
        expect(shouldSkipCompletion({before: 'The pipeline runs', after: '', title: 'T'}))
            .toBe(false);
    });
});

describe('buildCompletePrompt', () => {
    it('ends with the text before the caret', () => {
        const prompt = buildCompletePrompt({before: 'Deploys happen on', after: '', title: 'T'});
        expect(prompt.endsWith('Deploys happen on')).toBe(true);
    });

    it('includes the following text as context, before the text to continue', () => {
        const prompt = buildCompletePrompt({
            before: 'Deploys happen on',
            after: 'unless it is a holiday.',
            title: 'T',
        });
        expect(prompt.indexOf('unless it is a holiday.'))
            .toBeLessThan(prompt.indexOf('Deploys happen on'));
    });

    it('omits the following-text section when there is none', () => {
        const prompt = buildCompletePrompt({before: 'Deploys happen on', after: '  ', title: 'T'});
        expect(prompt).not.toContain('Text after the caret');
    });
});

describe('sanitizeCompletion', () => {
    it('unwraps a fence the model added despite being told not to', () => {
        expect(sanitizeCompletion('The pipeline runs', '```\n nightly.\n```')).toBe(' nightly.');
    });

    it('drops a repeat of the text before the caret', () => {
        const before = 'The deployment pipeline runs on ';
        const raw = 'The deployment pipeline runs on GitHub Actions.';
        expect(sanitizeCompletion(before, raw)).toBe('GitHub Actions.');
    });

    it('keeps a leading space, which is load-bearing mid-word', () => {
        expect(sanitizeCompletion('Deploys happen on', ' Fridays.')).toBe(' Fridays.');
    });

    it('does not treat a short coincidental overlap as an echo', () => {
        // "on " also ends the completion's own first words; too short to be a restatement.
        expect(sanitizeCompletion('Deploys happen on', ' on Fridays.')).toBe(' on Fridays.');
    });

    it('stops at the first blank line - a new paragraph is past what was asked for', () => {
        expect(sanitizeCompletion('The pipeline runs', ' nightly.\n\nIt also runs on merge.'))
            .toBe(' nightly.');
    });

    it('caps a runaway suggestion at a word boundary', () => {
        const raw = 'word '.repeat(200);
        const out = sanitizeCompletion('The pipeline runs', raw);
        expect(out.length).toBeLessThanOrEqual(COMPLETE_MAX_CHARS);
        expect(out.endsWith('word')).toBe(true);
    });

    it('returns nothing for a whitespace-only answer', () => {
        expect(sanitizeCompletion('The pipeline runs', '   \n  ')).toBe('');
        expect(sanitizeCompletion('The pipeline runs', '')).toBe('');
    });

    it('trims trailing whitespace so the ghost text does not end in a stray space', () => {
        expect(sanitizeCompletion('The pipeline runs', ' nightly.   ')).toBe(' nightly.');
    });
});

describe('pickFastModel', () => {
    it('replaces a flagship model with the fast one', () => {
        expect(pickFastModel('gpt-5', 'gpt-5-nano')).toBe('gpt-5-nano');
        expect(pickFastModel('claude-opus-5', 'claude-haiku-4-5')).toBe('claude-haiku-4-5');
        expect(pickFastModel('gemini-2.5-pro', 'gemini-2.5-flash-lite'))
            .toBe('gemini-2.5-flash-lite');
    });

    it('keeps a small model the user chose deliberately', () => {
        expect(pickFastModel('gpt-5-mini', 'gpt-5-nano')).toBe('gpt-5-mini');
        expect(pickFastModel('claude-haiku-4-5', 'claude-haiku-4-5')).toBe('claude-haiku-4-5');
        expect(pickFastModel('gemini-2.5-flash', 'gemini-2.5-flash-lite'))
            .toBe('gemini-2.5-flash');
    });
});

describe('buildMetadataPrompt', () => {
    it('offers the wiki\'s existing tags so the model reuses them', () => {
        const prompt = buildMetadataPrompt({
            title: 'Runbook',
            content: 'body',
            existingTags: ['deploy', 'oncall'],
        });
        expect(prompt).toContain('prefer these): deploy, oncall');
    });

    it('omits the tag line rather than claiming the wiki has no tags', () => {
        expect(buildMetadataPrompt({title: 'T', content: 'body', existingTags: []}))
            .not.toContain('already used');
    });

    it('labels an empty page', () => {
        expect(buildMetadataPrompt({title: 'T', content: '  ', existingTags: []}))
            .toContain('(this page is empty)');
    });
});

describe('parseAiMetadata', () => {
    const valid = '{"tags":["deploy"],"summary":"How we ship.","editSummary":"Added rollback."}';

    it('reads a clean object', () => {
        expect(parseAiMetadata(valid)).toEqual({
            tags: ['deploy'],
            summary: 'How we ship.',
            editSummary: 'Added rollback.',
        });
    });

    it('unwraps a fenced answer', () => {
        expect(parseAiMetadata('```json\n' + valid + '\n```').summary).toBe('How we ship.');
    });

    it('survives a preamble and a sign-off', () => {
        expect(parseAiMetadata(`Sure, here you go:\n${valid}\nHope that helps!`).tags)
            .toEqual(['deploy']);
    });

    it('folds whitespace in a tag to a hyphen', () => {
        const meta = parseAiMetadata('{"tags":["ci cd"],"summary":"s","editSummary":"e"}');
        expect(meta.tags).toEqual(['ci-cd']);
    });

    it('drops case-insensitive duplicates, which would split the tag list in two', () => {
        const meta = parseAiMetadata('{"tags":["Deploy","deploy"],"summary":"s","editSummary":"e"}');
        expect(meta.tags).toEqual(['Deploy']);
    });

    it('drops entries that are not usable tags', () => {
        const meta = parseAiMetadata('{"tags":["ok","",3,null,"  "],"summary":"s","editSummary":"e"}');
        expect(meta.tags).toEqual(['ok']);
    });

    it('caps the tag count', () => {
        const many = JSON.stringify({
            tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
            summary: 's',
            editSummary: 'e',
        });
        expect(parseAiMetadata(many).tags).toHaveLength(AI_METADATA_MAX_TAGS);
    });

    it('treats absent tags as none, since the summary is still usable', () => {
        expect(parseAiMetadata('{"summary":"s","editSummary":"e"}').tags).toEqual([]);
    });

    it('trims the summaries', () => {
        const meta = parseAiMetadata('{"tags":[],"summary":"  s  ","editSummary":"  e  "}');
        expect(meta).toMatchObject({summary: 's', editSummary: 'e'});
    });

    it('throws a typed error rather than returning junk', () => {
        const bad = [
            'I would rather not.',
            '{"summary":"s"}',
            '{"tags":"deploy","summary":"s","editSummary":"e"}',
            '{"tags":[],"summary":42,"editSummary":"e"}',
            '{"tags":[],"summary":"s",}',
            '[1,2,3]',
        ];
        for (const raw of bad) {
            expect(() => parseAiMetadata(raw)).toThrow(AiResponseFormatError);
        }
    });
});

describe('stripOuterFence', () => {
    it('removes a fence wrapping the whole answer', () => {
        expect(stripOuterFence('```markdown\n# Title\n```')).toBe('# Title');
    });

    it('leaves a page whose body merely contains a code block alone', () => {
        const page = '```sh\nls\n```\n\nThat lists files.';
        expect(stripOuterFence(page)).toBe(page);
    });

    it('leaves unfenced text untouched, including its leading space', () => {
        expect(stripOuterFence(' nightly.')).toBe(' nightly.');
    });
});
