import { Routes } from "@angular/router";
import {Login} from "./features/login/login";
import {Overview} from "./features/overview/overview";

export const routes: Routes = [
    {path: 'authentication', component: Login},
    {path: '', redirectTo: 'authentication', pathMatch: 'full'},
    {path: 'overview', component: Overview}
];
