import {SceneListItemDto, SceneStatus} from '../../../dtos/response/scene.dto';
import {isWaitingOnMe} from './scene-status';

/** A scene as the folder rail draws it. Small on purpose: the rail redraws on the board's clock. */
export interface SceneLeaf {
    channelId: string;
    name: string;
    status: SceneStatus;
    /** The scene is on a character this reader may speak as. */
    mine: boolean;
}

/** Rows the Recent block shows before it stops. */
export const RECENT_LIMIT = 5;

export function sceneLeaf(scene: SceneListItemDto, speakable: ReadonlySet<string>): SceneLeaf {
    return {
        channelId: scene.channelId,
        name: scene.name,
        status: scene.status,
        mine: isWaitingOnMe(scene, speakable),
    };
}

/** Scenes filed on each folder, keyed by folder id. An unfiled scene is not in any group. */
export function leavesByFolder(
    scenes: readonly SceneListItemDto[],
    speakable: ReadonlySet<string>,
): Record<string, SceneLeaf[]> {
    const grouped: Record<string, SceneLeaf[]> = {};
    for (const scene of scenes) {
        if (!scene.folderId) continue;
        (grouped[scene.folderId] ??= []).push(sceneLeaf(scene, speakable));
    }
    return grouped;
}

/** Waiting on you first, then whatever moved last. */
export function recentScenes(
    scenes: readonly SceneListItemDto[],
    speakable: ReadonlySet<string>,
    limit = RECENT_LIMIT,
): SceneLeaf[] {
    return [...scenes]
        .sort((a, b) => {
            const mine = Number(isWaitingOnMe(b, speakable)) - Number(isWaitingOnMe(a, speakable));
            return mine || movedAt(b) - movedAt(a);
        })
        .slice(0, limit)
        .map(scene => sceneLeaf(scene, speakable));
}

function movedAt(scene: SceneListItemDto): number {
    const stamp = scene.updatedAt ?? scene.createdAt;
    const parsed = stamp ? new Date(stamp).getTime() : 0;
    return Number.isNaN(parsed) ? 0 : parsed;
}
