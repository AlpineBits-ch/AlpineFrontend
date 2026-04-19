import { Routes } from "@angular/router";
import {Login} from "./features/login/login";

export const routes: Routes = [
    {path: 'authentication', component: Login},
    {path: '', redirectTo: 'authentication', pathMatch: 'full'},
];
