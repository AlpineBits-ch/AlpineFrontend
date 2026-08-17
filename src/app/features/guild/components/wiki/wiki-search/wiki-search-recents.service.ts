import {Injectable, signal} from '@angular/core';

const RECENT_LIMIT = 6;

/**
 * The last few queries that actually led somewhere. Recorded on selection rather than on
 * keystroke: "de", "dep", "depl" are not six searches, they are one. Local only, same reasoning as
 * `wiki-nav-prefs.service.ts`, with the same defensive storage handling as
 * `wiki-drafts.service.ts`, since a full or disabled localStorage must not break ⌘K.
 */
@Injectable({providedIn: 'root'})
export class WikiSearchRecentsService {
    private readonly queries = signal<readonly string[]>([]);
    readonly recent = this.queries.asReadonly();

    private guildId = '';

    load(guildId: string): void {
        if (!guildId || this.guildId === guildId) return;
        this.guildId = guildId;
        this.queries.set(this.read());
    }

    record(query: string): void {
        const trimmed = query.trim();
        if (!trimmed) return;
        const next = [
            trimmed,
            ...this.queries().filter(q => q.toLowerCase() !== trimmed.toLowerCase()),
        ].slice(0, RECENT_LIMIT);
        this.queries.set(next);
        this.write(next);
    }

    remove(query: string): void {
        const next = this.queries().filter(q => q !== query);
        this.queries.set(next);
        this.write(next);
    }

    clear(): void {
        this.queries.set([]);
        this.write([]);
    }

    private read(): string[] {
        try {
            const raw = localStorage.getItem(this.key());
            const parsed: unknown = raw ? JSON.parse(raw) : null;
            return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
        } catch {
            return [];
        }
    }

    private write(value: readonly string[]): void {
        try {
            localStorage.setItem(this.key(), JSON.stringify(value));
        } catch {
            // Storage disabled or full. History degrades to session-only rather than throwing inside the palette's keydown handler.
        }
    }

    /** Guild-scoped: one server's search history must not leak into another's palette. */
    private key(): string {
        return `wiki-search:recents:${this.guildId}`;
    }
}
