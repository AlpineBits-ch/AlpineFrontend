import {Injectable, signal} from '@angular/core';

export const SCENE_RAIL_STORAGE_KEY = 'venta.scene-rail';

const EMPTY: readonly string[] = [];

interface RailState {
    /** Open shelves, per guild. */
    expanded: Record<string, string[]>;
    /** Whether the playing screen shows the rail, per guild. */
    visible: Record<string, boolean>;
}

/** What the folder rail remembers between visits: which shelves are open, and whether it is shown. */
@Injectable({providedIn: 'root'})
export class SceneRailStateService {
    private readonly state = signal<RailState>(read());

    expanded(guildId: string | null | undefined): readonly string[] {
        if (!guildId) return EMPTY;
        return this.state().expanded[guildId] ?? EMPTY;
    }

    isExpanded(guildId: string | null | undefined, folderId: string): boolean {
        return this.expanded(guildId).includes(folderId);
    }

    toggle(guildId: string, folderId: string): void {
        this.state.update(state => {
            const open = state.expanded[guildId] ?? [];
            const next = open.includes(folderId) ? open.filter(id => id !== folderId) : [...open, folderId];
            return {...state, expanded: {...state.expanded, [guildId]: next}};
        });
        this.persist();
    }

    railVisible(guildId: string | null | undefined): boolean {
        if (!guildId) return false;
        return !!this.state().visible[guildId];
    }

    setRailVisible(guildId: string, visible: boolean): void {
        this.state.update(state => ({...state, visible: {...state.visible, [guildId]: visible}}));
        this.persist();
    }

    private persist(): void {
        try {
            localStorage.setItem(SCENE_RAIL_STORAGE_KEY, JSON.stringify(this.state()));
        } catch {
            // A full or unavailable store costs the memory of which shelves were open, nothing more.
        }
    }
}

function read(): RailState {
    const empty: RailState = {expanded: {}, visible: {}};
    try {
        const raw = localStorage.getItem(SCENE_RAIL_STORAGE_KEY);
        if (!raw) return empty;
        const parsed = JSON.parse(raw) as Partial<RailState>;
        return {expanded: parsed.expanded ?? {}, visible: parsed.visible ?? {}};
    } catch {
        return empty;
    }
}
