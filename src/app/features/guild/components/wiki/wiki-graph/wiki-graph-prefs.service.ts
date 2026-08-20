import {Injectable, signal} from '@angular/core';

type GraphPref = 'hierarchy' | 'links';

/**
 * Which edge classes the graph draws. Storage handling follows `wiki-nav-prefs.service.ts`: every
 * access is wrapped, since storage that is disabled, full or corrupt must degrade to the defaults
 * rather than break the view.
 */
@Injectable({providedIn: 'root'})
export class WikiGraphPrefsService {
    private readonly hierarchy = signal(true);
    private readonly links = signal(true);

    readonly showHierarchy = this.hierarchy.asReadonly();
    readonly showLinks = this.links.asReadonly();

    private guildId = '';

    /** Points the service at a guild. Idempotent: the caller is an effect that also runs for unrelated signal changes. */
    load(guildId: string): void {
        if (!guildId || this.guildId === guildId) return;
        this.guildId = guildId;
        this.hierarchy.set(this.read('hierarchy'));
        this.links.set(this.read('links'));
    }

    toggleHierarchy(): void {
        const next = !this.hierarchy();
        this.hierarchy.set(next);
        this.write('hierarchy', next);
    }

    toggleLinks(): void {
        const next = !this.links();
        this.links.set(next);
        this.write('links', next);
    }

    private read(kind: GraphPref): boolean {
        try {
            // Absent means never chosen, and both classes are on by default.
            return localStorage.getItem(this.key(kind)) !== 'false';
        } catch {
            return true;
        }
    }

    private write(kind: GraphPref, value: boolean): void {
        try {
            localStorage.setItem(this.key(kind), String(value));
        } catch {
            // Quota exceeded or storage disabled. The choice holds for the session and forgets on reload.
        }
    }

    /** Guild-scoped, like the nav's own preferences. */
    private key(kind: GraphPref): string {
        return `wiki-graph:${kind}:${this.guildId}`;
    }
}
