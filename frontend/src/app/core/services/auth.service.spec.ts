import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [AuthService, provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AuthService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('posts credentials to the login endpoint', () => {
    service.login('a@b.com', 'pw').subscribe();
    const req = httpMock.expectOne('/api/auth/login/');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ email: 'a@b.com', password: 'pw' });
    req.flush({ access: 'x', refresh: 'y' });
  });

  it('registers a user', () => {
    service.register({ email: 'a@b.com', password: 'pw' }).subscribe();
    const req = httpMock.expectOne('/api/users/register/');
    expect(req.request.method).toBe('POST');
    req.flush({ id: '1', email: 'a@b.com' });
  });
});
