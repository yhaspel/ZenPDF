import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { AnnotationsFacade } from '../../abstraction/annotations.facade';
import { WorkspaceShellFacade } from '../../abstraction/workspace-shell.facade';
import { Annotate } from './annotate';

/**
 * What a mode hands the phone bottom bar (design contract §3 Phone workspace).
 *
 * The bar cannot reach into a pane's undo stack, and the pane cannot reach the
 * bar — so the pane *publishes* and the bar draws whatever is published. The
 * two rules that matter are here: the published actions track the pane's own
 * state, and they go away with the pane, or the next mode inherits a Save that
 * belongs to a panel that is no longer on screen.
 */
describe('A mode publishes its actions to the bottom bar', () => {
  afterEach(() => TestBed.resetTestingModule());

  function mountAnnotate() {
    TestBed.configureTestingModule({
      imports: [Annotate],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const shell = TestBed.inject(WorkspaceShellFacade);
    const annotations = TestBed.inject(AnnotationsFacade);
    annotations.clear();
    const fixture = TestBed.createComponent(Annotate);
    fixture.componentRef.setInput('docId', 'doc-1');
    fixture.componentRef.setInput('pageCount', 3);
    fixture.detectChanges();
    return { fixture, shell, annotations };
  }

  it('publishes Undo, Redo and Save, disabled while there is nothing to do', () => {
    const { shell } = mountAnnotate();
    const actions = shell.paneActions();

    expect(actions.undo?.label).toBe('Undo');
    expect(actions.undo?.disabled).toBe(true);
    expect(actions.redo?.disabled).toBe(true);
    expect(actions.primary?.label).toBe('Save');
    expect(actions.primary?.disabled).toBe(true);
  });

  it('the published state follows the pane, mark by mark', () => {
    const { fixture, shell, annotations } = mountAnnotate();
    annotations.add({
      id: 's1', page: 0, type: 'square',
      rect: { x: 0.2, y: 0.2, w: 0.2, h: 0.1 }, color: '#332D24',
    });
    fixture.detectChanges();

    expect(shell.paneActions().undo?.disabled).toBe(false);
    expect(shell.paneActions().primary?.disabled).toBe(false);

    // Running the published Undo is the same operation as the page bar's.
    shell.paneActions().undo?.run();
    fixture.detectChanges();

    expect(annotations.all()).toHaveLength(0);
    expect(shell.paneActions().redo?.disabled).toBe(false);
  });

  it('takes them away when the mode goes', () => {
    const { fixture, shell } = mountAnnotate();
    expect(shell.paneActions().primary).toBeDefined();

    fixture.destroy();

    expect(shell.paneActions()).toEqual({});
    expect(shell.anyDrawerOpen()).toBe(false);
  });
});
