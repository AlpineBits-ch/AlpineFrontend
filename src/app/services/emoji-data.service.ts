import { Injectable, signal } from '@angular/core';

export interface EmojiSuggestion {
  id: string;
  native: string;
  name: string;
}

@Injectable({ providedIn: 'root' })
export class EmojiDataService {
  private _data = signal<any>(null);

  constructor() {
    import('@emoji-mart/data').then(mod => {
      this._data.set((mod as any).default ?? mod);
    });
  }

  /** Replace all :shortcode: patterns in text with their native emoji character.
   *  Reactive — reads the data signal, so callers inside computed() will re-run
   *  once the data finishes loading. */
  resolveShortcodes(text: string): string {
    const data = this._data();
    if (!data) return text;

    return text.replace(/:(\w+):/g, (match, shortcode) => {
      const q = shortcode.toLowerCase();
      let emoji = data.emojis[q];
      if (!emoji) {
        const aliasTarget = data.aliases?.[q];
        if (aliasTarget) emoji = data.emojis[aliasTarget];
      }
      return emoji?.skins?.[0]?.native ?? match;
    });
  }

  /** Search for emoji suggestions matching a shortcode prefix. */
  search(query: string): EmojiSuggestion[] {
    const data = this._data();
    if (!data) return [];
    const q = query.toLowerCase();
    const results: EmojiSuggestion[] = [];
    const seen = new Set<string>();

    for (const [alias, id] of Object.entries<string>(data.aliases ?? {})) {
      if (alias.startsWith(q) && !seen.has(id)) {
        const emoji = data.emojis[id];
        if (emoji?.skins?.[0]?.native) {
          seen.add(id);
          results.push({ id: alias, native: emoji.skins[0].native, name: emoji.name });
        }
      }
    }
    for (const [id, emoji] of Object.entries<any>(data.emojis ?? {})) {
      if (id.startsWith(q) && !seen.has(id) && (emoji as any)?.skins?.[0]?.native) {
        seen.add(id);
        results.push({ id, native: (emoji as any).skins[0].native, name: (emoji as any).name });
      }
    }
    return results.slice(0, 8);
  }

  /** Resolve a single :shortcode: to its native character, or null if not found. */
  resolveOne(shortcode: string): string | null {
    const data = this._data();
    if (!data) return null;
    const q = shortcode.toLowerCase();
    let emoji = data.emojis[q];
    if (!emoji) {
      const aliasTarget = data.aliases?.[q];
      if (aliasTarget) emoji = data.emojis[aliasTarget];
    }
    return emoji?.skins?.[0]?.native ?? null;
  }
}
