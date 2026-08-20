import {SceneDto, SceneListItemDto, SceneParticipantDto, SceneStatus} from '../../../dtos/response/scene.dto';

/** What ordering and "waiting on me" need. A board row and a whole scene both satisfy it. */
export type SceneOrderable = Pick<
    SceneListItemDto,
    'name' | 'status' | 'currentTurnPersonaId' | 'turnDeadlineAt'
>;

export interface SceneStatusMeta {
    status: SceneStatus;
    icon: string;
    labelKey: string;
    /** Tailwind classes for the chip. Kept here so every surface reads the same table. */
    chipClass: string;
}

const META: Readonly<Record<SceneStatus, SceneStatusMeta>> = {
    [SceneStatus.Open]: {
        status: SceneStatus.Open,
        icon: 'pi pi-users',
        labelKey: 'SCENE.STATUS.OPEN',
        chipClass: 'bg-white/[0.06] text-text-muted',
    },
    [SceneStatus.Active]: {
        status: SceneStatus.Active,
        icon: 'pi pi-play',
        labelKey: 'SCENE.STATUS.ACTIVE',
        chipClass: 'bg-online/15 text-online',
    },
    [SceneStatus.Paused]: {
        status: SceneStatus.Paused,
        icon: 'pi pi-pause',
        labelKey: 'SCENE.STATUS.PAUSED',
        chipClass: 'bg-connecting/15 text-connecting',
    },
    [SceneStatus.Concluded]: {
        status: SceneStatus.Concluded,
        icon: 'pi pi-bookmark-fill',
        labelKey: 'SCENE.STATUS.CONCLUDED',
        chipClass: 'bg-white/[0.05] text-text-faint',
    },
};

export function sceneStatusMeta(status: SceneStatus): SceneStatusMeta {
    return META[status] ?? META[SceneStatus.Open];
}

/** The order the board works through: what needs an answer first. */
export const SCENE_STATUS_ORDER: readonly SceneStatus[] = [
    SceneStatus.Active,
    SceneStatus.Open,
    SceneStatus.Paused,
    SceneStatus.Concluded,
];

export function participantOf(scene: SceneDto, personaId: string): SceneParticipantDto | null {
    return scene.participants.find(p => p.personaId === personaId) ?? null;
}

export function isAway(scene: SceneDto, personaId: string): boolean {
    return !!participantOf(scene, personaId)?.isAway;
}

/** The turn queue rotated so the character who is up comes first. */
export function queueFromCurrent(scene: SceneDto): string[] {
    const order = scene.turnOrder ?? [];
    const at = scene.currentTurnPersonaId ? order.indexOf(scene.currentTurnPersonaId) : -1;
    if (at < 0) return [...order];
    return [...order.slice(at), ...order.slice(0, at)];
}

/** Who is up after the current character, absences skipped the way the server skips them. */
export function upNext(scene: SceneDto): string | null {
    const rotated = queueFromCurrent(scene).slice(1);
    return rotated.find(id => !isAway(scene, id)) ?? rotated[0] ?? null;
}

/**
 * Whether the scene is waiting on this reader. Resolved from the characters they may speak as, so a
 * shared guild persona correctly holds up everybody who can play it.
 */
export function isWaitingOnMe(scene: SceneOrderable, speakablePersonaIds: ReadonlySet<string>): boolean {
    if (scene.status !== SceneStatus.Active || !scene.currentTurnPersonaId) return false;
    return speakablePersonaIds.has(scene.currentTurnPersonaId);
}

/** Board order: waiting on you first, then by status, then by whichever clock is tightest. */
export function compareScenes(
    a: SceneOrderable,
    b: SceneOrderable,
    speakable: ReadonlySet<string>,
    now: number,
): number {
    const mine = Number(isWaitingOnMe(b, speakable)) - Number(isWaitingOnMe(a, speakable));
    if (mine) return mine;

    const status = SCENE_STATUS_ORDER.indexOf(a.status) - SCENE_STATUS_ORDER.indexOf(b.status);
    if (status) return status;

    const deadline = (scene: SceneOrderable) =>
        scene.turnDeadlineAt ? new Date(scene.turnDeadlineAt).getTime() : now + 31_536_000_000;
    const byDeadline = deadline(a) - deadline(b);
    if (byDeadline) return byDeadline;

    return a.name.localeCompare(b.name);
}
