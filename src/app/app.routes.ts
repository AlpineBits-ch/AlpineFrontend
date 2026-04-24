import { Routes } from "@angular/router";
import {Login} from "./features/login/login";
import {OverviewComponent} from "./features/overview/overview.component";

export const routes: Routes = [
    {path: 'authentication', component: Login},
    {path: '', redirectTo: 'authentication', pathMatch: 'full'},
    {path: 'overview', component: OverviewComponent}
];
