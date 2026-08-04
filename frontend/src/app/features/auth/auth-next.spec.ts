import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { AuthFacade } from '../../abstraction/auth.facade';
import { Login } from './login';

/**
 * L12 — Login was the only door that forgot where you were going.
 *
 * The account gate sends `?next=` and `?reason=` to Register. Somebody who
 * turns out to already have an account clicks "Log in", and both were dropped:
 * they landed on the dashboard, one click from what they had been doing, with
 * nothing on the page to say why they were interrupted.
 */
describe('Login and the ?next= it was ignoring', () => {
  let navigated: string[];

  function configure(query: Record<string, string>) {
    navigated = [];
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AuthFacade, useValue: { login: () => of({}) } },
        {
          provide: Router,
          useValue: {
            navigateByUrl: (url: string) => {
              navigated.push(url);
              return Promise.resolve(true);
            },
            navigate: (commands: unknown[]) => {
              navigated.push(commands.join('/'));
              return Promise.resolve(true);
            },
            createUrlTree: () => ({}),
            serializeUrl: () => '',
          },
        },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap(query) } },
        },
      ],
    });
  }

  afterEach(() => TestBed.resetTestingModule());

  /**
   * Fill the form and submit it.
   *
   * The fields are set on the instance rather than driven through the DOM:
   * `ngModel` writes back in a microtask, and what is under test here is where
   * a successful sign-in *goes*, not that two-way binding works.
   */
  function signIn(fixture: ReturnType<typeof TestBed.createComponent<Login>>) {
    const cmp = fixture.componentInstance as unknown as {
      email: string;
      password: string;
      submit(): void;
    };
    cmp.email = 'a@b.com';
    cmp.password = 'pw';
    cmp.submit();
  }

  it('goes where the gate was sending you', () => {
    configure({ next: '/app/sign/new/doc-1', reason: 'sign' });
    const fixture = TestBed.createComponent(Login);
    fixture.detectChanges();
    signIn(fixture);
    expect(navigated).toEqual(['/app/sign/new/doc-1']);
  });

  it('refuses a next that points at another origin', () => {
    configure({ next: '//evil.example.com' });
    const fixture = TestBed.createComponent(Login);
    fixture.detectChanges();
    signIn(fixture);
    expect(navigated).toEqual(['/app/dashboard']);
  });

  it('falls back to the dashboard when there is no next', () => {
    configure({});
    const fixture = TestBed.createComponent(Login);
    fixture.detectChanges();
    signIn(fixture);
    expect(navigated).toEqual(['/app/dashboard']);
  });

  it('forwards next and reason on the link back to register', () => {
    configure({ next: '/app/sign/new/doc-1', reason: 'sign' });
    const fixture = TestBed.createComponent(Login);
    fixture.detectChanges();
    expect(fixture.componentInstance['registerLinkParams']()).toEqual({
      next: '/app/sign/new/doc-1',
      reason: 'sign',
    });
  });
});
