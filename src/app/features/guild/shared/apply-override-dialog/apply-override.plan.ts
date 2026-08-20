import {PermOverride} from '../permission-override-editor/permission-override-editor.component';

export type ApplyMode = 'replace' | 'merge';

export interface ApplyTarget {
    channelId: string;
    existing: PermOverride | null;
}

export interface ApplyStep {
    channelId: string;
    result: PermOverride;
    /** Writing this would change nothing, so it is counted and not sent. */
    skipped: boolean;
}

/** Unions both sides. A bit named on both wins as an allow, since that is the edit being made. */
export function mergeOverride(existing: PermOverride, incoming: PermOverride): PermOverride {
    const allow = existing.allow | incoming.allow;
    const deny = (existing.deny | incoming.deny) & ~incoming.allow;

    const allowModule = existing.allowModule | incoming.allowModule;
    const denyModule = (existing.denyModule | incoming.denyModule) & ~incoming.allowModule;

    return {
        allow: allow & ~incoming.deny,
        deny,
        allowModule: allowModule & ~incoming.denyModule,
        denyModule,
    };
}

function same(a: PermOverride, b: PermOverride): boolean {
    return (
        a.allow === b.allow &&
        a.deny === b.deny &&
        a.allowModule === b.allowModule &&
        a.denyModule === b.denyModule
    );
}

export function planApply(targets: ApplyTarget[], incoming: PermOverride, mode: ApplyMode): ApplyStep[] {
    return targets.map(target => {
        const result =
            mode === 'replace' || !target.existing ? incoming : mergeOverride(target.existing, incoming);

        return {
            channelId: target.channelId,
            result,
            skipped: target.existing !== null && same(target.existing, result),
        };
    });
}
