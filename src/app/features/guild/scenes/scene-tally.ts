import {SceneDto, SceneListItemDto} from '../../../dtos/response/scene.dto';

/** Enough to tally. A board row counts its cast, a whole scene carries it. */
export type SceneTallySource = Partial<Pick<SceneDto, 'participants' | 'createdAt' | 'concludedAt'>> &
    Pick<SceneListItemDto, 'postCount' | 'turnNumber' | 'participantCount'>;

/** One number and the word for it. Omitted entirely when the server did not count it. */
export interface TallyEntry {
    value: number;
    labelKey: string;
}

/**
 * What a scene amounted to. Shown when it ends, and on a concluded scene's closing mark: a
 * two-month game deserves a number attached to it, and the numbers are the ones a player remembers.
 */
export function sceneTally(scene: SceneTallySource, now: number = Date.now()): TallyEntry[] {
    const entries: TallyEntry[] = [];

    if (typeof scene.postCount === 'number' && scene.postCount > 0) {
        entries.push({value: scene.postCount, labelKey: 'SCENE.TALLY.POSTS'});
    }
    const cast = scene.participants?.length ?? scene.participantCount ?? 0;
    if (cast) entries.push({value: cast, labelKey: 'SCENE.TALLY.CHARACTERS'});
    if (typeof scene.turnNumber === 'number' && scene.turnNumber > 0) {
        entries.push({value: scene.turnNumber, labelKey: 'SCENE.TALLY.TURNS'});
    }

    const days = spanInDays(scene, now);
    if (days !== null && days > 0) entries.push({value: days, labelKey: 'SCENE.TALLY.DAYS'});

    return entries;
}

function spanInDays(scene: SceneTallySource, now: number): number | null {
    if (!scene.createdAt) return null;
    const from = new Date(scene.createdAt).getTime();
    const to = scene.concludedAt ? new Date(scene.concludedAt).getTime() : now;
    if (Number.isNaN(from) || Number.isNaN(to)) return null;
    return Math.max(Math.round((to - from) / 86_400_000), 0);
}
