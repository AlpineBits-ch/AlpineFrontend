import {inject, Injectable} from '@angular/core';
import {TranslateService} from '@ngx-translate/core';
import {LIST_LIMITS, validateNewListItem} from '../dtos/response/list.dto';
import {CreateListItemDto, UpdateListItemDto} from '../dtos/request/list.dto';
import {isTempListItemId, ListChannelState, ListStore} from '../stores/list.store';
import {ToastService} from './toast.service';

export {isTempListItemId};
export type {ListChannelState};

/**
 * The view-facing shape of {@link ListStore}. State, optimism and realtime all live in the store;
 * what is left here is the validation that produces a toast and the toasts themselves.
 */
@Injectable({providedIn: 'root'})
export class ListService {
    private store = inject(ListStore);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);

    // ── Reading ─────────────────────────────────────────────────────────────

    /** Never null. A channel nobody has opened reads as the shared frozen default. */
    stateFor(channelId: string): ListChannelState {
        return this.store.stateFor(channelId)();
    }

    /** Fetches once per channel per session; a list already loaded or in flight is left alone. */
    ensureLoaded(channelId: string): void {
        this.store.ensureLoaded(channelId);
    }

    reload(channelId: string): void {
        this.store.reload(channelId);
    }

    // ── Mutations ───────────────────────────────────────────────────────────

    /**
     * Adds a row, on screen first. Both caps are checked before the request: the server answers a
     * long `text` or a full list with a bare `400` and no field information, which surfaces to the
     * user as "Bad Request" for having typed a long line.
     *
     * @returns whether the row is on the server. `false` means it was refused or rolled back, and a
     *          toast has already explained which.
     */
    async addItem(channelId: string, dto: CreateListItemDto): Promise<boolean> {
        const rejection = validateNewListItem(dto.text, this.stateFor(channelId).items.length);
        if (rejection) {
            if (rejection === 'TEXT_TOO_LONG') {
                this.toastService.error(
                    this.translate.instant('LIST.ERROR_TEXT_TOO_LONG', {max: LIST_LIMITS.textMaxLength}),
                );
            } else if (rejection === 'LIST_FULL') {
                this.toastService.error(
                    this.translate.instant('LIST.ERROR_LIST_FULL', {max: LIST_LIMITS.maxItems}),
                );
            }
            return false;
        }

        try {
            await this.store.addItem(channelId, dto);
            return true;
        } catch (err) {
            this.toastService.httpError(this.translate.instant('LIST.ERROR_ADD'), err);
            return false;
        }
    }

    /**
     * Ticks or unticks, an absolute value, never a flip. Already in the requested state means the
     * request is skipped entirely, which is why a repeat can never surface as an error: there is no
     * failure path for an operation that was not performed.
     */
    async setChecked(channelId: string, itemId: string, checked: boolean): Promise<boolean> {
        const before = this.stateFor(channelId).items.find(item => item.id === itemId);
        if (!before) return false;
        if (before.isChecked === checked) return true;

        try {
            await this.store.setChecked(channelId, itemId, checked);
            return true;
        } catch (err) {
            this.toastService.httpError(this.translate.instant('LIST.ERROR_CHECK'), err);
            return false;
        }
    }

    /** Edits text/quantity/note/section/assignee. Own row needs `AddListItems`, anyone else's `ManageLists`. */
    async updateItem(channelId: string, itemId: string, dto: UpdateListItemDto): Promise<boolean> {
        const before = this.stateFor(channelId).items.find(item => item.id === itemId);
        if (!before) return false;

        if (dto.text !== undefined && dto.text.length > LIST_LIMITS.textMaxLength) {
            this.toastService.error(
                this.translate.instant('LIST.ERROR_TEXT_TOO_LONG', {max: LIST_LIMITS.textMaxLength}),
            );
            return false;
        }

        try {
            await this.store.updateItem(channelId, itemId, dto);
            return true;
        } catch (err) {
            this.toastService.httpError(this.translate.instant('LIST.ERROR_UPDATE'), err);
            return false;
        }
    }

    async deleteItem(channelId: string, itemId: string): Promise<boolean> {
        if (!this.stateFor(channelId).items.some(item => item.id === itemId)) return false;

        try {
            await this.store.deleteItem(channelId, itemId);
            return true;
        } catch (err) {
            this.toastService.httpError(this.translate.instant('LIST.ERROR_DELETE'), err);
            return false;
        }
    }

    /** Moves one row, and sends the smallest payload that describes the result. */
    async moveItem(channelId: string, fromIndex: number, toIndex: number): Promise<boolean> {
        try {
            return await this.store.moveItem(channelId, fromIndex, toIndex);
        } catch (err) {
            this.toastService.httpError(this.translate.instant('LIST.ERROR_REORDER'), err);
            return false;
        }
    }

    /** "Clear done", drops every ticked row. Needs `ManageLists`. */
    async clearChecked(channelId: string): Promise<boolean> {
        try {
            return await this.store.clearChecked(channelId);
        } catch (err) {
            this.toastService.httpError(this.translate.instant('LIST.ERROR_CLEAR'), err);
            return false;
        }
    }
}
