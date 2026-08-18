/**
 * The infobox is opaque JSON everywhere except here. The category holds the field list, the page
 * holds the answers, and this module is the only thing that knows either shape.
 */

export type InfoboxFieldType = 'text' | 'longtext' | 'number' | 'boolean' | 'date' | 'list' | 'link';

export interface InfoboxField {
    key: string;
    label: string;
    type?: InfoboxFieldType;
    required?: boolean;
    /** Shown under the input in the editor, never in the rendered box. */
    hint?: string;
}

export interface InfoboxGroup {
    label?: string;
    /** Field keys, in the order they are drawn. */
    fields: string[];
}

export interface InfoboxTemplate {
    /** Drawn at the top of the box. Falls back to the character's name. */
    title?: string;
    fields: InfoboxField[];
    groups?: InfoboxGroup[];
}

export type InfoboxValues = Record<string, unknown>;

export interface InfoboxRow {
    key: string;
    label: string;
    type: InfoboxFieldType;
    /** Already formatted for display. Empty means the field is unanswered. */
    text: string;
    /** List fields render as chips rather than one comma-joined string. */
    items: string[];
    required: boolean;
    /** Present in the values but not in the template, so removing a field never loses an answer. */
    untemplated: boolean;
}

export interface InfoboxSection {
    label: string | null;
    rows: InfoboxRow[];
}

export interface RenderedInfobox {
    title: string | null;
    sections: InfoboxSection[];
    /** True when nothing has been answered, so the page can leave the box out entirely. */
    isEmpty: boolean;
}

function parse<T>(raw: string | null | undefined): T | null {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw);
        return value && typeof value === 'object' ? (value as T) : null;
    } catch {
        return null;
    }
}

export function parseInfoboxTemplate(raw: string | null | undefined): InfoboxTemplate | null {
    const parsed = parse<InfoboxTemplate>(raw);
    if (!parsed || !Array.isArray(parsed.fields)) return null;
    return {
        title: typeof parsed.title === 'string' ? parsed.title : undefined,
        fields: parsed.fields.filter(f => f && typeof f.key === 'string' && f.key.length > 0),
        groups: Array.isArray(parsed.groups) ? parsed.groups : undefined,
    };
}

export function parseInfoboxValues(raw: string | null | undefined): InfoboxValues {
    return parse<InfoboxValues>(raw) ?? {};
}

/** Turns a stored value into the two things a row can draw: one string, or a list of chips. */
export function formatInfoboxValue(value: unknown, type: InfoboxFieldType): {text: string; items: string[]} {
    if (value === null || value === undefined || value === '') return {text: '', items: []};

    if (Array.isArray(value)) {
        const items = value.map(v => String(v).trim()).filter(Boolean);
        return {text: items.join(', '), items};
    }

    if (type === 'boolean' || typeof value === 'boolean') {
        return {text: value ? 'Yes' : 'No', items: []};
    }

    if (typeof value === 'object') return {text: '', items: []};

    const text = String(value).trim();
    return {text, items: type === 'list' && text ? text.split(',').map(s => s.trim()) : []};
}

function toRow(field: InfoboxField, values: InfoboxValues, untemplated = false): InfoboxRow {
    const type = field.type ?? 'text';
    const {text, items} = formatInfoboxValue(values[field.key], type);
    return {
        key: field.key,
        label: field.label,
        type,
        text,
        items,
        required: !!field.required,
        untemplated,
    };
}

/** A key with no label of its own: `homeWorld` reads as "Home world". */
export function humaniseKey(key: string): string {
    // Only the letter the split happened at is lowered, so `maxHP` keeps its acronym.
    const spaced = key
        .replace(/[_-]+/g, ' ')
        .replace(
            /([a-z0-9])([A-Z])(?![A-Z])/g,
            (_, before: string, after: string) => `${before} ${after.toLowerCase()}`,
        )
        .trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Answered fields first in template order, then anything the template no longer describes. Rows
 * with no answer survive only when the template marks them required, so a half-filled sheet reads
 * as a sheet rather than as a list of blanks.
 */
export function renderInfobox(
    templateJson: string | null | undefined,
    valuesJson: string | null | undefined,
    fallbackTitle: string | null = null,
): RenderedInfobox {
    const values = parseInfoboxValues(valuesJson);
    const template = parseInfoboxTemplate(templateJson);
    const seen = new Set<string>();
    const sections: InfoboxSection[] = [];

    const keep = (row: InfoboxRow) => !!row.text || row.items.length > 0 || row.required;

    if (template) {
        const byKey = new Map(template.fields.map(f => [f.key, f]));
        const grouped = new Set((template.groups ?? []).flatMap(g => g.fields));

        for (const group of template.groups ?? []) {
            const rows = group.fields
                .map(key => byKey.get(key))
                .filter((f): f is InfoboxField => !!f)
                .map(field => {
                    seen.add(field.key);
                    return toRow(field, values);
                })
                .filter(keep);
            if (rows.length) sections.push({label: group.label ?? null, rows});
        }

        const loose = template.fields
            .filter(field => !grouped.has(field.key))
            .map(field => {
                seen.add(field.key);
                return toRow(field, values);
            })
            .filter(keep);
        if (loose.length) sections.unshift({label: null, rows: loose});
    }

    const extras = Object.keys(values)
        .filter(key => !seen.has(key))
        .map(key => toRow({key, label: humaniseKey(key)}, values, true))
        .filter(row => !!row.text || row.items.length > 0);
    if (extras.length) sections.push({label: null, rows: extras});

    return {
        title: template?.title ?? fallbackTitle,
        sections,
        isEmpty: sections.every(section => section.rows.every(row => !row.text && !row.items.length)),
    };
}

/** The template's fields flattened into edit order, so the editor and the box agree. */
export function infoboxEditFields(template: InfoboxTemplate | null): InfoboxField[] {
    if (!template) return [];
    const byKey = new Map(template.fields.map(f => [f.key, f]));
    const grouped = (template.groups ?? []).flatMap(g => g.fields);
    const ordered = grouped.map(key => byKey.get(key)).filter((f): f is InfoboxField => !!f);
    const rest = template.fields.filter(f => !grouped.includes(f.key));
    return [...rest, ...ordered];
}

/** Drops blanks so an untouched field never lands in storage as `""`. */
export function serialiseInfoboxValues(values: InfoboxValues): string | null {
    const kept = Object.entries(values).filter(
        ([, value]) => value !== '' && value !== null && value !== undefined,
    );
    return kept.length ? JSON.stringify(Object.fromEntries(kept)) : null;
}
