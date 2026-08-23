import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Observable, Subject } from 'rxjs';

import { AnnotationsFacade } from '../../abstraction/annotations.facade';
import { CompareFacade } from '../../abstraction/compare.facade';
import { EsignFacade } from '../../abstraction/esign.facade';
import { JobsFacade } from '../../abstraction/jobs.facade';
import { Annotation, Job } from '../../core/models/models';
import { expectPollEndsWithPanel } from '../../testing/subscription-lifetime';
import { Annotate } from './annotate';
import { Compare } from './compare';
import { Convert } from './convert';
import { Protect } from './protect';
import { Sign } from './sign';

/**
 * Every panel's job poll ends when the panel does (queue, 2026-08-04).
 *
 * Five of the workspace panels subscribed to `JobsFacade.dispatch` bare. That
 * observable polls `GET /jobs/:id/` until the job is terminal, so leaving
 * Convert while an OCR ran left a timer, a closure over a destroyed component
 * and — when the job finally answered — a toast raised by a panel that no
 * longer existed. The two the sweep of 2026-08-22 called done, `edit.ts` and
 * `forms.ts`, had a `track()` helper; these did not.
 *
 * The assertion is on rxjs's own `observed`, which is what `takeUntilDestroyed`
 * flips — not on the presence of the operator in the source, which a lint rule
 * checks separately and which would pass for a chain that pipes the wrong
 * observable.
 */
describe('Workspace panels — a job poll dies with its panel', () => {
  let poll: Subject<Job>;

  /** Stand in for the polling `dispatch`, so the job never terminates. */
  function configure(...components: unknown[]): void {
    poll = new Subject<Job>();
    TestBed.configureTestingModule({
      imports: components as never[],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: JobsFacade, useValue: { dispatch: (): Observable<Job> => poll } },
      ],
    });
  }

  afterEach(() => TestBed.resetTestingModule());

  function mount<T>(type: Type<T>, inputs: Record<string, unknown> = {}): ComponentFixture<T> {
    const fixture = TestBed.createComponent(type);
    fixture.componentRef.setInput('docId', 'doc-1');
    for (const [name, value] of Object.entries(inputs)) {
      fixture.componentRef.setInput(name, value);
    }
    fixture.detectChanges();
    return fixture;
  }

  it('Convert — the OCR poll, which is the longest-running job in the product', () => {
    configure(Convert);
    const fixture = mount(Convert);
    const panel = fixture.componentInstance as unknown as { runOcr(): void };
    expectPollEndsWithPanel(fixture, poll, () => panel.runOcr());
  });

  it('Annotate — the save poll', () => {
    configure(Annotate);
    const fixture = mount(Annotate, { pageCount: 1 });
    const annotations = TestBed.inject(AnnotationsFacade);
    annotations.add({
      id: 's1', page: 0, type: 'square', rect: { x: 0.2, y: 0.2, w: 0.2, h: 0.1 },
    } as Annotation);
    const panel = fixture.componentInstance as unknown as { save(auto?: boolean): void };
    expectPollEndsWithPanel(fixture, poll, () => panel.save());
  });

  it('Compare — the compare poll', () => {
    configure(Compare);
    const fixture = mount(Compare);
    TestBed.inject(CompareFacade).setOther('doc-b');
    const panel = fixture.componentInstance as unknown as { run(): void };
    expectPollEndsWithPanel(fixture, poll, () => panel.run());
  });

  it('Protect — the unlock poll', () => {
    configure(Protect);
    const fixture = mount(Protect);
    const panel = fixture.componentInstance as unknown as { applyUnlock(): void };
    expectPollEndsWithPanel(fixture, poll, () => panel.applyUnlock());
  });

  it('Sign — the apply poll, which seals the file', () => {
    configure(Sign);
    const fixture = mount(Sign);
    const esign = TestBed.inject(EsignFacade);
    esign.place(0, { x: 0.2, y: 0.7, w: 0.2, h: 0.06 });
    const panel = fixture.componentInstance as unknown as { apply(): void };
    expectPollEndsWithPanel(fixture, poll, () => panel.apply());
  });
});
