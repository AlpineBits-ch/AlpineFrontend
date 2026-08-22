import {inject} from '@angular/core';
import {patchState, signalStore, withMethods, withState} from '@ngrx/signals';
import {catchError, Observable, tap, throwError} from 'rxjs';
import {ProfileCanvasDto} from '../dtos/response/profile-canvas.dto';
import {normalise} from '../models/profile-canvas';
import {ProfileCanvasApiService} from '../services/profile-canvas-api.service';

interface CanvasEntry {
    canvas?: ProfileCanvasDto;
    loading: boolean;
    requestId: number;
}

interface ProfileCanvasState {
    byProfile: Record<string, CanvasEntry>;
    saving: boolean;
}

export const ProfileCanvasStore = signalStore(
    {providedIn: 'root'},
    withState<ProfileCanvasState>({byProfile: {}, saving: false}),

    withMethods((store, api = inject(ProfileCanvasApiService)) => {
        function put(profileId: string, entry: CanvasEntry): void {
            patchState(store, {byProfile: {...store.byProfile(), [profileId]: entry}});
        }

        return {
            /** Cache read. The popout relies on this never reaching the wire. */
            canvasFor(profileId: string): ProfileCanvasDto | undefined {
                return store.byProfile()[profileId]?.canvas;
            },

            ensureLoaded(profileId: string): void {
                const entry = store.byProfile()[profileId];
                if (entry?.loading || entry?.canvas) return;

                const requestId = (entry?.requestId ?? 0) + 1;
                put(profileId, {canvas: entry?.canvas, loading: true, requestId});

                api.get(profileId).subscribe({
                    next: canvas => {
                        if (store.byProfile()[profileId]?.requestId !== requestId) return;
                        put(profileId, {canvas: normalise(canvas), loading: false, requestId});
                    },
                    error: () => {
                        if (store.byProfile()[profileId]?.requestId !== requestId) return;
                        const current = store.byProfile()[profileId];
                        put(profileId, {...current, loading: false});
                    },
                });
            },

            save(canvas: ProfileCanvasDto): Observable<ProfileCanvasDto> {
                const profileId = canvas.profileId;
                const previous = store.byProfile()[profileId];
                const requestId = (previous?.requestId ?? 0) + 1;

                put(profileId, {canvas: normalise(canvas), loading: false, requestId});
                patchState(store, {saving: true});

                return api.save({theme: canvas.theme, widgets: canvas.widgets}).pipe(
                    tap(saved => {
                        patchState(store, {saving: false});
                        put(profileId, {canvas: normalise(saved), loading: false, requestId});
                    }),
                    catchError((err: unknown) => {
                        patchState(store, {saving: false});
                        if (previous) put(profileId, previous);
                        return throwError(() => err);
                    }),
                );
            },
        };
    }),
);
