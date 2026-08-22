import {computed, inject} from '@angular/core';
import {patchState, signalStore, withComputed, withHooks, withMethods, withState} from '@ngrx/signals';
import {catchError, Observable, tap, throwError} from 'rxjs';
import {ProfileCanvasDto} from '../dtos/response/profile-canvas.dto';
import {normalise} from '../models/profile-canvas';
import {ProfileCanvasApiService} from '../services/profile-canvas-api.service';
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {WsProfileCanvasUpdated} from '../services/realtime-events';

interface CanvasEntry {
    canvas?: ProfileCanvasDto;
    loading: boolean;
    requestId: number;
}

interface ProfileCanvasState {
    byProfile: Record<string, CanvasEntry>;
    savingProfiles: Record<string, true>;
}

export const ProfileCanvasStore = signalStore(
    {providedIn: 'root'},
    withState<ProfileCanvasState>({byProfile: {}, savingProfiles: {}}),

    withComputed(store => ({
        /** True while any profile has a save in flight. Save-button disabled state binds to this. */
        saving: computed(() => Object.keys(store.savingProfiles()).length > 0),
    })),

    withMethods((store, api = inject(ProfileCanvasApiService)) => {
        function put(profileId: string, entry: CanvasEntry): void {
            patchState(store, {byProfile: {...store.byProfile(), [profileId]: entry}});
        }

        // Undoes an optimistic write that had no prior entry to restore to.
        function remove(profileId: string): void {
            const {[profileId]: _dropped, ...rest} = store.byProfile();
            patchState(store, {byProfile: rest});
        }

        function startSaving(profileId: string): void {
            patchState(store, {savingProfiles: {...store.savingProfiles(), [profileId]: true}});
        }

        // Called on every exit path of save(): a profile left in here is deaf to its own realtime events forever.
        function stopSaving(profileId: string): void {
            const {[profileId]: _dropped, ...rest} = store.savingProfiles();
            patchState(store, {savingProfiles: rest});
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
                startSaving(profileId);

                return api.save({theme: canvas.theme, widgets: canvas.widgets}).pipe(
                    tap(saved => {
                        stopSaving(profileId);
                        // A newer save or load has since taken this profile; leave its entry alone.
                        if (store.byProfile()[profileId]?.requestId !== requestId) return;
                        put(profileId, {canvas: normalise(saved), loading: false, requestId});
                    }),
                    catchError((err: unknown) => {
                        stopSaving(profileId);
                        if (store.byProfile()[profileId]?.requestId === requestId) {
                            // loading: false always, even when previous was a load still in flight:
                            // that request already dropped itself once this save superseded it.
                            if (previous) put(profileId, {...previous, loading: false});
                            else remove(profileId);
                        }
                        return throwError(() => err);
                    }),
                );
            },
        };
    }),

    withHooks({
        onInit(store) {
            const realtime = inject(RealtimeConnectionService);

            realtime.stream('social.ProfileCanvasUpdated').subscribe((event: WsProfileCanvasUpdated) => {
                const entry = store.byProfile()[event.profileId];
                if (!entry?.canvas) return;
                // Our own save for this profile echoes back as this event, arriving after the optimistic write.
                if (store.savingProfiles()[event.profileId]) return;

                patchState(store, {
                    byProfile: {
                        ...store.byProfile(),
                        [event.profileId]: {...entry, canvas: normalise(event.canvas)},
                    },
                });
            });
        },
    }),
);
