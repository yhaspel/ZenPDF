// @ts-check
'use strict';

/**
 * `.subscribe(` inside a component must be tied to the component's lifetime.
 *
 * Why a rule and not a review habit: the sweep of 2026-08-22 fixed five files,
 * declared the job done, and left sixty-six bare subscriptions standing in
 * twenty-four others — including `convert.ts`, whose OCR poll is the longest
 * running job in the product. Phase 12 then rewrote large parts of those same
 * files and fixed none of them. A grep-in-a-spec would catch the same thing;
 * a rule reports it at the line, in the editor, before the commit.
 *
 * What counts as tied: somewhere in the chain the `.subscribe()` hangs off,
 * there is a `.pipe(…)` carrying a call to `takeUntilDestroyed`. That is
 * deliberately structural rather than clever — it does not try to prove the
 * operator is applied to *this* observable, which is what the runtime
 * assertions in `panels-die-cleanly.spec.ts` are for (they read rxjs's own
 * `observed` flag after destroying the fixture). The two checks answer
 * different halves of the question, and neither is sufficient alone.
 *
 * The exemptions are listed here, in the open, each with its reason. There is
 * no inline escape hatch on purpose: an exemption that can be granted in the
 * file it applies to is an exemption nobody reviews.
 */

/** `file basename` → the method whose subscription may outlive the component. */
const EXEMPT = {
  // The route guard runs *because* the workspace is about to be destroyed, so
  // cancelling the save on destruction would lose exactly the work the autosave
  // exists to keep. See `Workspace.confirmLeave`'s own comment.
  'workspace.ts': ['confirmLeave'],
  // The fetch lives inside an `effect`, whose `onCleanup` unsubscribes it — the
  // same guarantee by a different mechanism, and the one that also revokes the
  // object URL. See `PdfThumbnail`.
  'pdf-thumbnail.ts': ['constructor'],
};

/** Walk out of a `.subscribe()` callee looking for a `takeUntilDestroyed` pipe. */
function chainIsTied(node) {
  let current = node;
  while (current) {
    if (
      current.type === 'CallExpression'
      && current.callee.type === 'MemberExpression'
      && current.callee.property.type === 'Identifier'
      && current.callee.property.name === 'pipe'
      && current.arguments.some(isTakeUntilDestroyed)
    ) {
      return true;
    }
    if (current.type === 'CallExpression') current = current.callee;
    else if (current.type === 'MemberExpression') current = current.object;
    else return false;
  }
  return false;
}

function isTakeUntilDestroyed(argument) {
  return argument.type === 'CallExpression'
    && argument.callee.type === 'Identifier'
    && argument.callee.name === 'takeUntilDestroyed';
}

/**
 * The nearest enclosing member's name, for the exemption list.
 *
 * A constructor's `key` is an `Identifier` named `constructor`, so it needs no
 * case of its own — which is what lets `PdfThumbnail`'s `effect` be exempted
 * by the member it is written in.
 */
function enclosingMember(node) {
  for (let current = node.parent; current; current = current.parent) {
    const named = current.type === 'MethodDefinition' || current.type === 'PropertyDefinition';
    if (named && current.key.type === 'Identifier') return current.key.name;
  }
  return '';
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A subscription started by a component must end with it: pipe it through '
        + 'takeUntilDestroyed(this.destroyRef).',
    },
    schema: [],
    messages: {
      bare:
        'This subscription outlives the component. Pipe it through '
        + 'takeUntilDestroyed(this.destroyRef) — a job poll left running keeps a '
        + 'timer, a destroyed component\'s closures, and a toast nobody asked for. '
        + 'If it must survive on purpose, add it to EXEMPT in '
        + 'tools/eslint-rules/subscriptions-die-with-the-component.js with the reason.',
    },
  },
  create(context) {
    const basename = (context.filename ?? context.getFilename()).split('/').pop();
    const exempt = EXEMPT[basename] ?? [];
    return {
      CallExpression(node) {
        if (
          node.callee.type !== 'MemberExpression'
          || node.callee.property.type !== 'Identifier'
          || node.callee.property.name !== 'subscribe'
        ) {
          return;
        }
        if (chainIsTied(node.callee)) return;
        if (exempt.includes(enclosingMember(node))) return;
        context.report({ node, messageId: 'bare' });
      },
    };
  },
};
