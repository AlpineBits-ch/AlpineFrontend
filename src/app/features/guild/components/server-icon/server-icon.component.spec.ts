import {ComponentFixture, TestBed} from '@angular/core/testing';

import {ServerIconComponent} from './server-icon.component';

describe('ServerIconComponent', () => {
    let component: ServerIconComponent;
    let fixture: ComponentFixture<ServerIconComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [ServerIconComponent]
        })
            .compileComponents();

        fixture = TestBed.createComponent(ServerIconComponent);
        fixture.componentRef.setInput('serverData', {
            id: 'test',
            name: 'Test Server',
            isHome: false,
        });
        component = fixture.componentInstance;
        fixture.detectChanges();
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });
});
