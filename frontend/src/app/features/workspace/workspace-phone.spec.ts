import { MediaMatcher } from '@angular/cdk/layout';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { WorkspaceShellFacade } from '../../abstraction/workspace-shell.facade';
import { DocumentModel } from '../../core/models/models';
import { DocumentsService } from '../../core/services/documents.service';
import { FakeMediaMatcher } from '../../shared/fake-media-matcher';
import { Workspace } from './workspace';

/**
 * The workspace at the `md` breakpoint (design contract §3 Phone workspace).
 *
 * Two claims, and the second matters as much as the first: below `md` the bar
 * is at the bottom and the mode nav is not on the top bar; at or above `md`
 * **nothing is different from before**, which §10 makes an invariant.
 */
describe('Workspace — the phone layout', () => {
  let fixture: ComponentFixture<Workspace>;
  let media: FakeMediaMatcher;
  let shell: WorkspaceShellFacade;

  function build(narrow: boolean) {
    media = new FakeMediaMatcher(narrow);
    const fakeDocs: Partial<DocumentsService> = {
      get: () => of({ id: 'doc-1', title: 'A file', page_count: 3 } as DocumentModel) as never,
      versions: () => of({ count: 0, next: null, previous: null, results: [] }) as never,
      outline: () => of({ outline: [] }) as never,
      contentUrl: () => '',
    };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: MediaMatcher, useValue: media },
        { provide: DocumentsService, useValue: fakeDocs },
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: of(convertToParamMap({ id: 'doc-1' })),
            queryParamMap: of(convertToParamMap({})),
            snapshot: { paramMap: convertToParamMap({ id: 'doc-1' }) },
          },
        },
      ],
    });
    fixture = TestBed.createComponent(Workspace);
    shell = TestBed.inject(WorkspaceShellFacade);
    fixture.detectChanges();
  }

  function one(selector: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(selector);
  }

  it('below md: the modes are at the bottom and the top bar keeps only ⋯', () => {
    build(true);

    expect(one('[data-test=ws-bottom-bar]')).not.toBeNull();
    expect(one('[data-test=ws-more]')).not.toBeNull();
    // The desktop `.seg` mode nav is not rendered at all — it moved, and the
    // bottom bar's own buttons are what replaced it.
    expect(one('[data-test=view-toggle]')).toBeNull();
    expect(one('[data-test=annotate-toggle]')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('[data-test=ws-bottom-mode]')).toHaveLength(9);
    // The bar keeps the title, the meta and the theme toggle.
    expect(one('[data-test=doc-title]')?.textContent?.trim()).toBe('A file');
    expect(one('app-theme-toggle')).not.toBeNull();
  });

  it('below md: the bar cluster is in the More sheet, and there is one of each', () => {
    build(true);

    // One set of elements, not two — the bar and the sheet render the same
    // `<ng-template>`, so a suite never has to say *which* Download it means.
    for (const test of ['undo-version', 'redo-version', 'tool-split', 'tool-compress',
      'download', 'shortcuts-open']) {
      expect(fixture.nativeElement.querySelectorAll(`[data-test=${test}]`)).toHaveLength(1);
    }
    const sheet = one('[data-ws-drawer=more]')!;
    expect(sheet.querySelector('[data-test=download]')).not.toBeNull();
    expect(shell.barDrawers().some((d) => d.key === 'more')).toBe(false);
  });

  it('every sheet has a head, including the one with no rail behind it', () => {
    // The More sheet shipped without one for an hour: the head is a separate
    // element in each rail's template, and the insertion that added it to the
    // seven rails matched on a one-line `<aside …>` — the More sheet's opening
    // tag is two lines. A sheet with no head has no title and no way to close
    // it but Escape or the scrim, which is exactly the sort of thing that
    // reads as fine in a diff.
    build(true);
    for (const drawer of shell.drawers()) {
      const sheet = one(`[data-ws-drawer=${drawer.key}]`)!;
      expect(sheet, drawer.key).not.toBeNull();
      expect(sheet.querySelector('.ws-drawer-title')?.textContent?.trim(), drawer.key)
        .toBe(drawer.label);
      expect(sheet.querySelector('[data-test=ws-drawer-close]'), drawer.key).not.toBeNull();
    }
    expect([...shell.drawers()].map((d) => d.key).sort()).toEqual(['more', 'start']);
  });

  it('below md: the view rail is the Pages drawer', () => {
    build(true);
    expect(shell.barDrawers()).toEqual([{ key: 'start', label: 'Pages', barOpener: true }]);
    expect(one('[data-ws-drawer=start] [data-test=tab-thumbs]')).not.toBeNull();
  });

  it('below md: the scrim appears only while a drawer is open', () => {
    build(true);
    expect(one('[data-test=ws-drawer-scrim]')).toBeNull();

    shell.toggleDrawer('start');
    fixture.detectChanges();
    expect(one('[data-test=ws-drawer-scrim]')).not.toBeNull();

    shell.closeDrawer();
    fixture.detectChanges();
    expect(one('[data-test=ws-drawer-scrim]')).toBeNull();
  });

  it('at md and above: the bar is exactly what it was, and there is no bottom bar', () => {
    build(false);

    expect(one('[data-test=ws-bottom-bar]')).toBeNull();
    expect(one('[data-test=ws-more]')).toBeNull();
    expect(one('[data-ws-drawer=more]')).toBeNull();
    expect(one('[data-test=ws-drawer-scrim]')).toBeNull();
    for (const test of ['view-toggle', 'organize-toggle', 'edit-toggle', 'annotate-toggle',
      'forms-toggle', 'convert-toggle', 'compare-toggle', 'sign-toggle', 'protect-toggle',
      'undo-version', 'redo-version', 'tool-split', 'tool-compress', 'download',
      'shortcuts-open']) {
      expect(fixture.nativeElement.querySelectorAll(`[data-test=${test}]`)).toHaveLength(1);
    }
    // The rail is still a rail: no head, no dialog.
    expect(one('[data-test=ws-drawer]')).toBeNull();
    expect(one('[data-ws-drawer=start]')?.getAttribute('role')).toBeNull();
  });

  it('changing mode closes whatever drawer was open', () => {
    build(true);
    shell.toggleDrawer('start');
    fixture.detectChanges();
    expect(shell.anyDrawerOpen()).toBe(true);

    one('[data-mode=organize]')!.click();
    fixture.detectChanges();

    expect(shell.anyDrawerOpen()).toBe(false);
    expect(one('[data-test=organize-grid]')).not.toBeNull();
  });

  it('crossing the breakpoint swaps the layout without a reload', () => {
    build(false);
    expect(one('[data-test=view-toggle]')).not.toBeNull();

    media.resize(true);
    fixture.detectChanges();

    expect(one('[data-test=view-toggle]')).toBeNull();
    expect(one('[data-test=ws-bottom-bar]')).not.toBeNull();

    media.resize(false);
    fixture.detectChanges();

    expect(one('[data-test=view-toggle]')).not.toBeNull();
    expect(one('[data-test=ws-bottom-bar]')).toBeNull();
  });
});
