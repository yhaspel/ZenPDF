import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { TokenService } from '../services/token.service';
import { authInterceptor } from './auth.interceptor';

const UNAUTHORIZED = { status: 401, statusText: 'Unauthorized' };

describe('authInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let tokens: TokenService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    });
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
    tokens = TestBed.inject(TokenService);
    tokens.set('old-access', 'old-refresh');
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.clear();
  });

  it('stores the rotated refresh token and retries with the new access token', () => {
    http.get('/api/documents/').subscribe();
    httpMock.expectOne('/api/documents/').flush(null, UNAUTHORIZED);

    httpMock
      .expectOne('/api/auth/refresh/')
      .flush({ access: 'new-access', refresh: 'new-refresh' });

    const retry = httpMock.expectOne('/api/documents/');
    expect(retry.request.headers.get('Authorization')).toBe('Bearer new-access');
    retry.flush({});

    // The old refresh token is blacklisted server-side after rotation.
    expect(tokens.refresh).toBe('new-refresh');
  });

  it('issues a single refresh for concurrent 401s', () => {
    http.get('/api/documents/').subscribe();
    http.get('/api/folders/').subscribe();
    httpMock.expectOne('/api/documents/').flush(null, UNAUTHORIZED);
    httpMock.expectOne('/api/folders/').flush(null, UNAUTHORIZED);

    const refreshes = httpMock.match('/api/auth/refresh/');
    expect(refreshes.length).toBe(1);
    refreshes[0].flush({ access: 'new-access', refresh: 'new-refresh' });

    httpMock.expectOne('/api/documents/').flush({});
    httpMock.expectOne('/api/folders/').flush({});
  });
});
