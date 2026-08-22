import {Type} from '@angular/core';
import {Routes} from '@angular/router';
import {hasSession} from './guards/session.guard';

/** Where a launch goes, decided before anything is drawn. `authentication` must stay unguarded. */
export function appRoutes(login: Type<unknown>, overview: Type<unknown>, profile: Type<unknown>): Routes {
    return [
        {path: 'authentication', component: login},
        {path: 'overview', component: overview, canMatch: [hasSession]},
        {path: 'profile', component: profile, canMatch: [hasSession]},
        {path: '', redirectTo: 'overview', pathMatch: 'full'},
    ];
}
