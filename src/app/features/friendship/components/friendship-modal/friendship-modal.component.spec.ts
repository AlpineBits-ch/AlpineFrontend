import { ComponentFixture, TestBed } from '@angular/core/testing';

import { FriendshipModalComponent } from './friendship-modal.component';

describe('FriendshipModalComponent', () => {
  let component: FriendshipModalComponent;
  let fixture: ComponentFixture<FriendshipModalComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FriendshipModalComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(FriendshipModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
