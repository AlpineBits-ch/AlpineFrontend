import {Component, inject} from '@angular/core';
import {AuthService} from "../../services/auth.service";
import {Router} from "@angular/router";
import {Button} from "primeng/button";

@Component({
  selector: 'app-overview',
  imports: [
    Button
  ],
  templateUrl: './overview.component.html',
  styleUrl: './overview.component.css',
})
export class OverviewComponent {
  protected  authService = inject(AuthService);

  protected router = inject(Router);
  public logout(): void {
    this.authService.logout();
    this.router.navigate(['/authentication']);
  }
}
