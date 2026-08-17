/**
 * Line-level diff over wiki page content.
 *
 * A classic LCS dynamic-programming table rather than Myers: page revisions are at most a few
 * hundred lines, where O(n*m) is imperceptible, and the table version is short enough to read.
 * Written by hand deliberately - pulling in a diff package for sixty lines is not worth the
 * dependency.
 */

export type DiffOp = 'add' | 'del' | 'ctx';

export interface DiffLine {
    type: DiffOp;
    text: string;
}

export interface DiffStat {
    added: number;
    removed: number;
}

/** `''.split('\n')` is `['']`, which would report a phantom line for an empty document. */
function toLines(text: string): string[] {
    return text === '' ? [] : text.split('\n');
}

export function diffLines(before: string, after: string): DiffLine[] {
    const a = toLines(before);
    const b = toLines(after);
    const m = a.length;
    const n = b.length;

    // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
    const lcs: number[][] = Array.from({length: m + 1}, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }

    const out: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (a[i] === b[j]) {
            out.push({type: 'ctx', text: a[i]});
            i++;
            j++;
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            // Deletions are emitted before additions on a tie so a replaced line reads as
            // "was X, now Y" rather than the reverse.
            out.push({type: 'del', text: a[i]});
            i++;
        } else {
            out.push({type: 'add', text: b[j]});
            j++;
        }
    }
    while (i < m) out.push({type: 'del', text: a[i++]});
    while (j < n) out.push({type: 'add', text: b[j++]});
    return out;
}

export function diffStat(lines: readonly DiffLine[]): DiffStat {
    return {
        added: lines.filter(l => l.type === 'add').length,
        removed: lines.filter(l => l.type === 'del').length,
    };
}
