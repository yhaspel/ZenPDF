# Screen-reader pass: the signing ceremony

§10.3 calls this the legally sensitive flow. axe and the keyboard test in
`e2e/tests/phase-10-a11y.spec.ts` prove the controls are reachable, labelled
and operable — a signer completes the whole ceremony there with Tab, Enter and
Space. What they cannot prove is that the experience is *comprehensible*. That
is what this is for.

Run it once per release, on the ceremony only. About twenty minutes.

**Setup.** VoiceOver on macOS Safari (⌘F5) or NVDA on Windows Firefox. Send
yourself a one-signer envelope with one signature field and one text field.
Open the emailed link. **Then put the mouse away** — VO-arrow / NVDA-arrow and
Tab only. Note anything you had to guess at.

| # | Do this | You must hear | Pass if |
|---|---|---|---|
| 1 | Open the link | The page title, then the document title as a heading | You know what document this is and who sent it |
| 2 | Read down to the disclosure | "Electronic signature disclosure, region" — and you can read the whole text with arrow keys | The text is reachable without a mouse. This was a real bug; do not assume |
| 3 | Tab to the checkbox | The full sentence "I agree to sign electronically…", then "unticked, checkbox" | What you are agreeing to is spoken, not just "checkbox" |
| 4 | Space | "ticked" | The state change is announced |
| 5 | Tab | "Agree and continue, button" | It is in the tab order now and was skipped before step 4, because it is disabled until you agree |
| 6 | Enter | The document title, as a heading | Focus moves to what you are signing rather than back to the top of the page |
| 7 | Navigate by heading | The document title | The sign screen has a heading of its own |
| 8 | Tab to the first field | "Signature, required", and which page it is on | You know what is being asked and where |
| 9 | Enter on "Sign here" | "Your signature, dialog", and the first tab | The dialog names itself **for the field you are on** — on an initials field it must not say "signature" |
| 10 | Tab through Draw / Type / Upload | Which one is currently active | Selection is announced, not only coloured |
| 11 | Activate "Type", Tab to the box, type your name | The box is named, and the preview is announced when it renders | You know a signature now exists without looking |
| 12 | Tab through the fonts, pick one | Which is chosen | Selection is announced, not only coloured |
| 13 | Tab to "Use this", Enter | That the field is signed, and the progress ("1 of 2 done") | You are not left guessing whether it worked |
| 14 | Reach and complete the text field | The field name, then that it saved | Saving on blur is not silent |
| 15 | Tab to Finish, Enter | "All done — thank you" as a heading, then the download links | The end of the flow is unambiguous |
| 16 | **Turn off your monitor and repeat steps 8–15** | — | You can complete it. This is the actual test |

**Pass = every step clean, and step 16 completed with the screen off.**

Anything you had to guess at is a finding. File it with the step number, the
screen reader and browser, and what you actually heard — "I expected X and
heard Y" is worth more than "step 12 is broken".

## What is deliberately not here

**The Draw tab is not keyboard-operable, and will not be.** A canvas stroke
driven by arrow keys is a worse signature than a typed one, and a
WCAG-conformant alternative — Type — sits in the same dialog. If a tester
reports it, that is the answer.

## History

Steps 6, 7, 10, 12 and the silence at 13 were open gaps when this script was
written and were closed in the same change: focus moves to the document title
on consent, the sign screen has a real heading, both button groups carry
`aria-pressed`, the typed preview is a live region, and the progress line is a
status region. If a run finds any of them back, that is a regression rather
than a known gap.
