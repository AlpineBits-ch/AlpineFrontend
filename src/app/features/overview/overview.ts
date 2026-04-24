import {Component, inject} from '@angular/core';
import {AuthService} from "../../services/auth-service";
import {Router} from "@angular/router";
import {Button} from "primeng/button";

@Component({
  selector: 'app-overview',
  imports: [
    Button
  ],
  templateUrl: './overview.html',
  styleUrl: './overview.css',
})
export class Overview {
  protected  authService = inject(AuthService);

  protected router = inject(Router);
  public logout(): void {
    this.authService.logout();
    this.router.navigate(['/authentication']);
  }
}
