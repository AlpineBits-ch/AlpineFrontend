import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {map, Observable} from 'rxjs';
import {environment} from '../../environments/environment';

export interface GifResult {
    id: number;
    title: string;
    /** Full animated GIF URL -sent as the message */
    url: string;
    /** Static JPEG thumbnail -used for grid preview */
    previewUrl: string;
}

// ── Klipy response shape ──────────────────────────────────────────────────────

interface KlipyFileVariant {
    gif?: { url: string; width: number; height: number };
    webp?: { url: string };
    jpg?: { url: string };
    mp4?: { url: string };
}

interface KlipyItem {
    id: number;
    title: string;
    file: {
        hd: KlipyFileVariant;
        md?: KlipyFileVariant;
    };
}

interface KlipyResponse {
    result: boolean;
    data: {
        data: KlipyItem[];
        current_page: number;
        per_page: number;
        has_next: boolean;
    };
}

// ── Service ───────────────────────────────────────────────────────────────────

const BASE = `https://api.klipy.com/api/v1`;
const PER_PAGE = 24;

@Injectable({providedIn: 'root'})
export class GifService {
    private http = inject(HttpClient);

    trending(): Observable<GifResult[]> {
        const params = new HttpParams().set('per_page', PER_PAGE);
        return this.http
            .get<KlipyResponse>(`${BASE}/${environment.klipyApiKey}/gifs/trending`, {params})
            .pipe(map(r => r.data.data.map(toResult)));
    }

    search(query: string): Observable<GifResult[]> {
        const params = new HttpParams()
            .set('q', query)
            .set('per_page', PER_PAGE);
        return this.http
            .get<KlipyResponse>(`${BASE}/${environment.klipyApiKey}/gifs/search`, {params})
            .pipe(map(r => r.data.data.map(toResult)));
    }
}

function toResult(item: KlipyItem): GifResult {
    return {
        id: item.id,
        title: item.title,
        url: item.file.hd.gif?.url ?? '',
        previewUrl: item.file.hd.jpg?.url ?? item.file.hd.gif?.url ?? '',
    };
}

/** Returns true when a message content string is a Klipy CDN GIF URL */
export function isKlipyGifUrl(text: string): boolean {
    return /^https:\/\/static\.klipy\.com\/.+/i.test(text.trim());
}
