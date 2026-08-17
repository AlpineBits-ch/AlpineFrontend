import {Type} from "@angular/core";
import {Routes} from "@angular/router";
import {hasSession} from "./guards/session.guard";

/** Where a launch goes, decided before anything is drawn. `authentication` must stay unguarded. */
export function appRoutes(login: Type<unknown>, overview: Type<unknown>): Routes {
    return [
        {path: 'authentication', component: login},
        {path: 'overview', component: overview, canMatch: [hasSession]},
        {path: '', redirectTo: 'overview', pathMatch: 'full'},
    ];
}
