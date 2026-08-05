import {describe, expect, it} from 'vitest';
import {buildDraftPrompt, isAiProviderId, stripOuterFence} from './ai-provider';

const base = {
    prompt: 'document the deploy process',
    title: 'Deploys',
    existingContent: '',
    pageTitles: [] as readonly string[],
};

describe('buildDraftPrompt', () => {
    it('includes the user prompt and the page title', () => {
        const out = buildDraftPrompt(base);
        expect(out).toContain('document the deploy process');
        expect(out).toContain('Deploys');
    });

    it('includes existing content when the page is not empty', () => {
        expect(buildDraftPrompt({...base, existingContent: '## Current steps'}))
            .toContain('## Current steps');
    });

    // An empty page must not send an empty "existing content" section - it reads to the model
    // as "the page exists and is blank on purpose".
    it('omits the existing-content section entirely for a blank page', () => {
        expect(buildDraftPrompt(base).toLowerCase()).not.toContain('existing content');
    });

    it('treats whitespace-only content as blank', () => {
        expect(buildDraftPrompt({...base, existingContent: '   \n  '}).toLowerCase())
            .not.toContain('existing content');
    });

    it('lists sibling page titles so the model can reference them', () => {
        expect(buildDraftPrompt({...base, pageTitles: ['Setup', 'Rollback']}))
            .toContain('Rollback');
    });

    it('omits the sibling list when there are no other pages', () => {
        expect(buildDraftPrompt(base).toLowerCase()).not.toContain('other pages');
    });

    it('falls back to Untitled rather than sending an empty title', () => {
        expect(buildDraftPrompt({...base, title: ''})).toContain('Untitled');
    });
});

describe('stripOuterFence', () => {
    it('removes a fence wrapping the whole answer', () => {
        expect(stripOuterFence('```markdown\n# Hi\n```')).toBe('# Hi');
    });

    it('leaves unfenced text alone', () => {
        expect(stripOuterFence('# Hi')).toBe('# Hi');
    });

    // The whole point of the middle-fence check: a page about shell scripts is mostly fences,
    // and eating the first and last lines of it would corrupt real content.
    it('leaves a document that merely starts with a code block alone', () => {
        const doc = '```bash\nls\n```\n\nThen do the thing.\n\n```bash\ncd /\n```';
        expect(stripOuterFence(doc)).toBe(doc);
    });

    it('handles a fence with no language tag', () => {
        expect(stripOuterFence('```\nplain\n```')).toBe('plain');
    });

    it('leaves an unterminated fence alone', () => {
        expect(stripOuterFence('```md\n# Hi')).toBe('```md\n# Hi');
    });
});

describe('isAiProviderId', () => {
    it('accepts the three known providers', () => {
        expect(isAiProviderId('anthropic')).toBe(true);
        expect(isAiProviderId('openai')).toBe(true);
        expect(isAiProviderId('gemini')).toBe(true);
    });

    it('rejects anything else', () => {
        expect(isAiProviderId('claude')).toBe(false);
        expect(isAiProviderId(null)).toBe(false);
        expect(isAiProviderId(3)).toBe(false);
    });
});
