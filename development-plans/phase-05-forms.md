# Phase 5 — Forms

**Goal:** fill existing AcroForms in-browser and save into the PDF; create/edit form fields; import/export data; flatten. (XFA and JavaScript field logic are out of scope — see 02-feature-matrix.)

Depends on: Phase 3 (overlay), Phase 4 helpful but not required.

## Backend

### Read model
`GET /api/documents/{id}/form/` → `{has_form, is_xfa (detected → UI warns "legacy XFA not supported, fields shown may be incomplete"), fields: [{name, type ∈ {text, checkbox, radio, combobox, listbox, signature}, page, rect §8, value, default, options[], flags: {required, readonly, multiline, password}, max_len, radio_group}]}` via PyMuPDF widgets iteration.

### Operations
- `fill_form`: `{values: {name: value}, flatten_after: bool}` — engine iterates widgets, sets `field_value`, `update()`; checkbox/radio use on-state names correctly; unknown names → validation error listing them. Result version labeled "Form filled".
- `edit_form_fields_batch`: `ops[]` of add/update/delete with field spec `{type, name (unique, validated), page, rect §8, options?, required?, default?, font_size?, align?}` — engine: `page.add_widget(fitz.Widget(...))` for text/checkbox/radio/combobox/listbox (radio groups: N widgets sharing a name with distinct on-values). **Signature fields: PyMuPDF cannot create them (its Widget API is read-only for signatures) — the engine routes `type=signature` through pyHanko `fields.append_signature_field(SigFieldSpec(...))` instead.** The result is an empty signature field: a visual signing placeholder. End-user certificate-based filling is out of scope — P8's flows stamp signature images and apply the platform seal rather than fill user certificates.
- `import_form_data`: JSON `{name: value}` or CSV (2 columns name,value; or wide 1-row) → same as fill_form. `GET /api/documents/{id}/form/export/?format=json|csv` → current values download.
- `flatten` with `what=form` (bake widgets via `Document.bake()`; values become page content, fields removed).

## Frontend

- **Fill mode** (default when doc has form): viewer renders widgets (ngx-extended-pdf-viewer renders AcroForm fields and exposes values via its `[(formData)]` two-way binding); our `FormsFacade` mirrors values (extract on load, two-way to viewer's form layer events), Save → `fill_form` job; "Export data" / "Import data" buttons; "Flatten" with confirm ("makes fields permanent, not undoable except via version history").
- **Field editor mode** (tool tab "Form builder"): overlay placement of new fields (drag rect, type palette), property panel (name auto-suggested `text_1`…, options editor for choice fields, required/readonly/multiline), move/resize existing, delete; Save commits ONE `edit_form_fields_batch` op containing all adds/updates/deletes — engine applies them in one pass → one version "Form edited".
- Fallback fill path: if PDF.js widget interaction proves unreliable for a field type (listbox quirks etc.), facade renders our own overlay inputs positioned from the read model — decision per field type during implementation; both paths speced against the same read model.

## Tests
Golden: fill every field type on form fixture and re-extract equals set values; checkbox on-state correctness; radio group exclusivity; create fields → fill → flatten → text present, widgets gone; import CSV/JSON parity; XFA fixture (add one to corpus from a public sample) detected and warned, no crash; unknown-name error lists names.
E2E: open form fixture → fill 4 field types in-browser → save → reload shows values → export JSON → flatten → download.

## Acceptance criteria

- [ ] **Guest parity + tool pages (§20 DoD item 9, §21.6):** every tool in this phase works end-to-end with no account, and ships its public SSR page — `/fill-pdf-form` — with unique title/meta/H1 and an entry in the generated `sitemap.xml`.
- [ ] Form fixture fillable end-to-end in-browser; saved values visible in external viewers.
- [ ] Build a form from a blank PDF: 6 field types placed, named, filled, exported, flattened.
- [ ] Import round-trip: export JSON → clear → import → identical values.
- [ ] XFA document degrades gracefully with the warning banner.

## Risks
- PDF.js forms layer ↔ our save cycle (viewer reload after version bump must not lose focus context) → save reloads doc; acceptable v1 friction, autosave-on-blur softens it.
- Widget appearance streams (fonts in filled text) → PyMuPDF regenerates appearances on `update()`; golden pixel checks on two zoom levels.
