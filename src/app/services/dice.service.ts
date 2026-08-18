import {inject, Injectable, Injector, signal} from '@angular/core';
import {Observable, tap} from 'rxjs';
import {RoleplayApi} from './roleplay-api.service';
import {DiceRollDto} from '../dtos/response/dice.dto';
import {RollDiceDto} from '../dtos/request/dice.dto';

/** How long a roll counts as having just landed, and therefore settles rather than appearing. */
export const DICE_SETTLE_WINDOW_MS = 5_000;

const RECENT_LIMIT = 6;

/**
 * Rolling, plus the handful of expressions this session has used. A campaign rolls the same
 * attack twenty times, and retyping it is the friction the tray exists to remove.
 */
@Injectable({providedIn: 'root'})
export class DiceService {
    private readonly injector = inject(Injector);
    private readonly recentByChannel = signal<Record<string, string[]>>({});

    private get api(): RoleplayApi {
        return this.injector.get(RoleplayApi);
    }

    recent(channelId: string | null | undefined): string[] {
        return channelId ? (this.recentByChannel()[channelId] ?? []) : [];
    }

    roll(guildId: string, channelId: string, dto: RollDiceDto): Observable<DiceRollDto> {
        return this.api.roll(guildId, channelId, dto).pipe(
            // The server's normalisation is remembered, not what was typed, so the list is canonical.
            tap(result => this.remember(channelId, result.expression)),
        );
    }

    private remember(channelId: string, expression: string): void {
        this.recentByChannel.update(map => {
            const existing = (map[channelId] ?? []).filter(e => e !== expression);
            return {...map, [channelId]: [expression, ...existing].slice(0, RECENT_LIMIT)};
        });
    }
}

/** Whether a roll arrived just now, and so is worth animating. Scrollback never is. */
export function rollJustLanded(createdAt: Date | string | null | undefined): boolean {
    if (!createdAt) return false;
    const at = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
    if (Number.isNaN(at)) return false;
    return Date.now() - at < DICE_SETTLE_WINDOW_MS;
}
