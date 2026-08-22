import {Routes} from '@angular/router';
import {Login} from './features/login/login.component';
import {MainPageComponent} from './features/main-page/main-page.component';
import {ProfilePageComponent} from './features/profile/profile-page/profile-page.component';
import {appRoutes} from './app.routes.table';

/** The table in {@link appRoutes}, bound to the screens it routes between. */
export const routes: Routes = appRoutes(Login, MainPageComponent, ProfilePageComponent);
