import {describe, expect, it} from 'vitest';
import {
    humaniseKey,
    infoboxEditFields,
    parseInfoboxTemplate,
    renderInfobox,
    serialiseInfoboxValues,
} from './persona-infobox';

const template = JSON.stringify({
    title: 'Character',
    fields: [
        {key: 'species', label: 'Species', required: true},
        {key: 'age', label: 'Age'},
        {key: 'allies', label: 'Allies', type: 'list'},
        {key: 'alive', label: 'Alive', type: 'boolean'},
    ],
    groups: [{label: 'Vitals', fields: ['species', 'age']}],
});

describe('parseInfoboxTemplate', () => {
    it('returns null for malformed JSON rather than throwing', () => {
        expect(parseInfoboxTemplate('{not json')).toBeNull();
    });

    it('returns null when there is no field list', () => {
        expect(parseInfoboxTemplate('{"title":"x"}')).toBeNull();
    });

    it('drops a field with no key', () => {
        const parsed = parseInfoboxTemplate('{"fields":[{"label":"Nameless"},{"key":"a","label":"A"}]}');
        expect(parsed?.fields.map(f => f.key)).toEqual(['a']);
    });
});

describe('renderInfobox', () => {
    it('groups answered fields under their group label', () => {
        const box = renderInfobox(template, JSON.stringify({species: 'Human', age: '58'}));
        const vitals = box.sections.find(s => s.label === 'Vitals');
        expect(vitals?.rows.map(r => r.label)).toEqual(['Species', 'Age']);
    });

    it('drops an unanswered optional field but keeps an unanswered required one', () => {
        const box = renderInfobox(template, JSON.stringify({age: '58'}));
        const labels = box.sections.flatMap(s => s.rows.map(r => r.label));
        expect(labels).toContain('Species');
        expect(labels).not.toContain('Allies');
    });

    it('renders a list as chips rather than one joined string', () => {
        const box = renderInfobox(template, JSON.stringify({allies: ['Wren', 'Thorne']}));
        const row = box.sections.flatMap(s => s.rows).find(r => r.key === 'allies');
        expect(row?.items).toEqual(['Wren', 'Thorne']);
    });

    it('renders a boolean as a word', () => {
        const box = renderInfobox(template, JSON.stringify({alive: false}));
        const row = box.sections.flatMap(s => s.rows).find(r => r.key === 'alive');
        expect(row?.text).toBe('No');
    });

    it('keeps an answer the template no longer describes', () => {
        const box = renderInfobox(template, JSON.stringify({species: 'Human', homeWorld: 'Ashfen'}));
        const row = box.sections.flatMap(s => s.rows).find(r => r.key === 'homeWorld');
        expect(row).toMatchObject({label: 'Home world', text: 'Ashfen', untemplated: true});
    });

    it('renders answers with no template at all', () => {
        const box = renderInfobox(null, JSON.stringify({species: 'Human'}), 'Cogsgrove');
        expect(box.title).toBe('Cogsgrove');
        expect(box.sections.flatMap(s => s.rows).map(r => r.text)).toEqual(['Human']);
    });

    it('has nothing to draw when there are no answers', () => {
        const box = renderInfobox(null, null);
        expect(box.sections).toEqual([]);
        expect(box.isEmpty).toBe(true);
    });
});

describe('infoboxEditFields', () => {
    it('offers every field, ungrouped ones first', () => {
        const fields = infoboxEditFields(parseInfoboxTemplate(template));
        expect(fields.map(f => f.key)).toEqual(['allies', 'alive', 'species', 'age']);
    });

    it('offers nothing without a template', () => {
        expect(infoboxEditFields(null)).toEqual([]);
    });
});

describe('serialiseInfoboxValues', () => {
    it('drops blanks so an untouched field is never stored', () => {
        expect(serialiseInfoboxValues({species: 'Human', age: '', alive: null})).toBe('{"species":"Human"}');
    });

    it('is null when everything is blank', () => {
        expect(serialiseInfoboxValues({age: ''})).toBeNull();
    });
});

describe('humaniseKey', () => {
    it('splits camelCase and snake_case', () => {
        expect(humaniseKey('homeWorld')).toBe('Home world');
        expect(humaniseKey('first_seen')).toBe('First seen');
    });
});
