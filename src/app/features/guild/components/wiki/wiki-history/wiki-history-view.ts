import {DiffLine} from '../wiki-diff';
import {WikiRevisionDto} from '../../../../../dtos/response/wiki.dto';

/**
 * Presentation-only shaping for the history view: what a diff looks like in two columns, and how a
 * flat list of revisions becomes "Today / Yesterday / 14 Mar".
 *
 * Kept out of the component because both are pure and both have edge cases worth pinning down -
 * a replaced line has to line up across the gutter, and a day boundary is a local-time question.
 */

export type SideBySideKind = 'ctx' | 'add' | 'del' | 'mod';

export interface SideBySideRow {
    kind: SideBySideKind;
    /** The line as it was, or `null` where the right side has no counterpart. */
    left: string | null;
    /** The line as it is now, or `null` where the left side lost one. */
    right: string | null;
}

/**
 * Pairs each removed line with the added line that replaced it.
 *
 * The unified diff emits a replacement as a run of deletions followed by a run of additions, which
 * in two columns would show every "was X" several rows above its "now Y". Buffering each run and
 * zipping them is what makes the two sides read across rather than down.
 */
export function toSideBySide(lines: readonly DiffLine[]): SideBySideRow[] {
    const rows: SideBySideRow[] = [];
    let removed: string[] = [];
    let added: string[] = [];

    const flush = () => {
        const pairs = Math.max(removed.length, added.length);
        for (let i = 0; i < pairs; i++) {
            const left = i < removed.length ? removed[i] : null;
            const right = i < added.length ? added[i] : null;
            rows.push({
                kind: left !== null && right !== null ? 'mod' : left !== null ? 'del' : 'add',
                left,
                right,
            });
        }
        removed = [];
        added = [];
    };

    for (const line of lines) {
        if (line.type === 'del') {
            removed.push(line.text);
        } else if (line.type === 'add') {
            added.push(line.text);
        } else {
            flush();
            rows.push({kind: 'ctx', left: line.text, right: line.text});
        }
    }
    flush();
    return rows;
}

export type DayRelation = 'today' | 'yesterday' | null;

export interface RevisionDayGroup {
    /** Local calendar day, `YYYY-MM-DD`. Stable enough to track a `@for` on. */
    key: string;
    date: Date;
    /**
     * Left as a discriminator rather than a string: the label is translated, and a pure function
     * has no business reaching for a translation service.
     */
    relation: DayRelation;
    revisions: WikiRevisionDto[];
}

export function groupRevisionsByDay(
    revisions: readonly WikiRevisionDto[],
    now: Date = new Date(),
): RevisionDayGroup[] {
    const groups: RevisionDayGroup[] = [];
    const byKey = new Map<string, RevisionDayGroup>();
    const todayKey = dayKey(now);
    const yesterdayKey = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));

    for (const revision of revisions) {
        const date = new Date(revision.createdAt);
        // An unparseable stamp still belongs somewhere; its own bucket beats an `Invalid Date`
        // heading over every revision in the list.
        const key = Number.isNaN(date.getTime()) ? 'unknown' : dayKey(date);
        let group = byKey.get(key);
        if (!group) {
            group = {
                key,
                date,
                relation: key === todayKey ? 'today' : key === yesterdayKey ? 'yesterday' : null,
                revisions: [],
            };
            byKey.set(key, group);
            // Input order is preserved rather than re-sorted: the server hands revisions back
            // newest first, and re-deriving that ordering here would be a second opinion about it.
            groups.push(group);
        }
        group.revisions.push(revision);
    }

    return groups;
}

/** Local, not UTC: "today" is the user's day, and `toISOString` would shift it by the offset. */
function dayKey(date: Date): string {
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}
