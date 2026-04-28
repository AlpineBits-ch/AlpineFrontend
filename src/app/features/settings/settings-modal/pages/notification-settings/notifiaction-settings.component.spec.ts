import { ComponentFixture, TestBed } from '@angular/core/testing';

import { NotifiactionSettingsComponent } from './notifiaction-settings.component';

describe('NotifiactionSettingsComponent', () => {
  let component: NotifiactionSettingsComponent;
  let fixture: ComponentFixture<NotifiactionSettingsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NotifiactionSettingsComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(NotifiactionSettingsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
