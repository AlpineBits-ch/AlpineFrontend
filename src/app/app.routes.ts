import {Routes} from "@angular/router";
import {Login} from "./features/login/login.component";
import {MainPageComponent} from "./features/main-page/main-page.component";

export const routes: Routes = [
    {path: 'authentication', component: Login},
    {path: '', redirectTo: 'authentication', pathMatch: 'full'},
    {path: 'overview', component: MainPageComponent},
];
