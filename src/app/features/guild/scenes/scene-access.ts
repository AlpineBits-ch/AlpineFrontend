import {
    SceneDto,
    SceneJoinPolicy,
    SceneListItemDto,
    SceneVisibility,
} from '../../../dtos/response/scene.dto';

/**
 * The three tables a scene can be. The fourth pair the two fields could express, hidden but open to
 * anyone, is refused by the server: you cannot walk into a scene you cannot see.
 */
export const SceneAccessPreset = {
    OpenTable: 'OpenTable',
    AskToJoin: 'AskToJoin',
    PrivateTable: 'PrivateTable',
} as const;

export type SceneAccessPreset = (typeof SceneAccessPreset)[keyof typeof SceneAccessPreset];

export interface SceneAccessMeta {
    preset: SceneAccessPreset;
    joinPolicy: SceneJoinPolicy;
    visibility: SceneVisibility;
    icon: string;
    labelKey: string;
    hintKey: string;
}

export const SCENE_ACCESS_PRESETS: readonly SceneAccessMeta[] = [
    {
        preset: SceneAccessPreset.OpenTable,
        joinPolicy: SceneJoinPolicy.Open,
        visibility: SceneVisibility.Everyone,
        icon: 'pi pi-users',
        labelKey: 'SCENE.ACCESS.OPEN_TABLE',
        hintKey: 'SCENE.ACCESS.OPEN_TABLE_HINT',
    },
    {
        preset: SceneAccessPreset.AskToJoin,
        joinPolicy: SceneJoinPolicy.Ask,
        visibility: SceneVisibility.Everyone,
        icon: 'pi pi-hand',
        labelKey: 'SCENE.ACCESS.ASK_TO_JOIN',
        hintKey: 'SCENE.ACCESS.ASK_TO_JOIN_HINT',
    },
    {
        preset: SceneAccessPreset.PrivateTable,
        joinPolicy: SceneJoinPolicy.Ask,
        visibility: SceneVisibility.Cast,
        icon: 'pi pi-lock',
        labelKey: 'SCENE.ACCESS.PRIVATE_TABLE',
        hintKey: 'SCENE.ACCESS.PRIVATE_TABLE_HINT',
    },
];

export function accessMeta(preset: SceneAccessPreset): SceneAccessMeta {
    return SCENE_ACCESS_PRESETS.find(meta => meta.preset === preset) ?? SCENE_ACCESS_PRESETS[0];
}

/**
 * Which table a scene is set to. A cast-only scene reads as private whatever its join policy says,
 * so a pair the server should never have stored still renders as the tighter of the two.
 */
export function presetOf(
    joinPolicy: SceneJoinPolicy | null | undefined,
    visibility: SceneVisibility | null | undefined,
): SceneAccessPreset {
    if (visibility === SceneVisibility.Cast) return SceneAccessPreset.PrivateTable;
    return joinPolicy === SceneJoinPolicy.Ask
        ? SceneAccessPreset.AskToJoin
        : SceneAccessPreset.OpenTable;
}

/** What the scene answers to. A scene with no access fields yet behaves as an open table. */
type SceneAccess = Pick<SceneDto | SceneListItemDto, 'joinPolicy' | 'visibility'>;

/** Getting a character in needs the GM's yes. */
export function needsPermission(scene: SceneAccess | null | undefined): boolean {
    return scene?.joinPolicy === SceneJoinPolicy.Ask;
}

/** Only the cast and the GMs can see it at all. */
export function isPrivate(scene: SceneAccess | null | undefined): boolean {
    return scene?.visibility === SceneVisibility.Cast;
}
