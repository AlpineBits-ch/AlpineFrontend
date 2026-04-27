import { Injectable, signal } from '@angular/core';

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
}
