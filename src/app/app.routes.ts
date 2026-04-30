import { Routes } from "@angular/router";
import {Login} from "./features/login/login";
import {MainPageComponent} from "./features/main-page/main-page.component";
import {ToastPopupComponent} from "./toast-popup/toast-popup.component";

export const routes: Routes = [
    {path: 'authentication', component: Login},
    {path: '', redirectTo: 'authentication', pathMatch: 'full'},
    {path: 'overview', component: MainPageComponent},
    {path: 'toast-popup', component: ToastPopupComponent},
];
