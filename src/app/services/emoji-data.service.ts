import { Injectable, signal } from '@angular/core';

export function getFlagCode(ch1: string, ch2?: string): string | null {
  const cp1 = ch1.codePointAt(0);
  const cp2 = ch2?.codePointAt(0);
  if (cp1 === undefined || cp2 === undefined) return null;
  if (cp1 < 0x1F1E6 || cp1 > 0x1F1FF) return null;
  if (cp2 < 0x1F1E6 || cp2 > 0x1F1FF) return null;
  return (
    String.fromCodePoint(cp1 - 0x1F1E6 + 65) +
    String.fromCodePoint(cp2 - 0x1F1E6 + 65)
  ).toLowerCase();
}

export function isRegionalIndicator(ch: string): boolean {
  const cp = ch.codePointAt(0);
  return cp !== undefined && cp >= 0x1F1E6 && cp <= 0x1F1FF;
}

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

    return text.replace(/:(\w[\w-]*):/g, (match, shortcode) => {
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
      if (alias.includes(q) && !seen.has(id)) {
        const emoji = data.emojis[id];
        if (emoji?.skins?.[0]?.native) {
          seen.add(id);
          results.push({ id: alias, native: emoji.skins[0].native, name: emoji.name });
        }
      }
    }
    for (const [id, emoji] of Object.entries<any>(data.emojis ?? {})) {
      if (id.includes(q) && !seen.has(id) && (emoji as any)?.skins?.[0]?.native) {
        seen.add(id);
        results.push({ id, native: (emoji as any).skins[0].native, name: (emoji as any).name });
      }
    }
    return results.slice(0, 12);
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
