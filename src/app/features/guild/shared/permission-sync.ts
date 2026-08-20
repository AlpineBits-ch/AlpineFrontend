import {ChannelPermission} from '../../../dtos/response/guild.dto';

export interface OverrideDiffRow {
    targetId: string;
    kind: 'role' | 'member';
    change: 'added' | 'removed' | 'changed' | 'same';
}

function keyOf(perm: ChannelPermission): string | null {
    return perm.roleId ?? perm.memberId ?? null;
}

function kindOf(perm: ChannelPermission): 'role' | 'member' {
    return perm.roleId ? 'role' : 'member';
}

/** All four masks, since a module-only difference is still a difference. */
function sameMasks(a: ChannelPermission, b: ChannelPermission): boolean {
    return (
        a.allowPermissions === b.allowPermissions &&
        a.denyPermissions === b.denyPermissions &&
        (a.allowModulePermissions ?? 'None') === (b.allowModulePermissions ?? 'None') &&
        (a.denyModulePermissions ?? 'None') === (b.denyModulePermissions ?? 'None')
    );
}

/** What syncing this channel with its category would change, one row per target. */
export function diffOverrides(
    channel: ChannelPermission[],
    category: ChannelPermission[],
): OverrideDiffRow[] {
    const byKey = new Map<string, {channel?: ChannelPermission; category?: ChannelPermission}>();

    for (const perm of channel) {
        const key = keyOf(perm);
        if (key) byKey.set(key, {...byKey.get(key), channel: perm});
    }

    for (const perm of category) {
        const key = keyOf(perm);
        if (key) byKey.set(key, {...byKey.get(key), category: perm});
    }

    const rows: OverrideDiffRow[] = [];
    for (const [targetId, pair] of byKey) {
        const source = pair.channel ?? pair.category!;
        const kind = kindOf(source);

        if (!pair.category) rows.push({targetId, kind, change: 'removed'});
        else if (!pair.channel) rows.push({targetId, kind, change: 'added'});
        else if (!sameMasks(pair.channel, pair.category)) rows.push({targetId, kind, change: 'changed'});
        else rows.push({targetId, kind, change: 'same'});
    }

    return rows;
}

export function isSyncedWithCategory(channel: ChannelPermission[], category: ChannelPermission[]): boolean {
    return diffOverrides(channel, category).every(row => row.change === 'same');
}
