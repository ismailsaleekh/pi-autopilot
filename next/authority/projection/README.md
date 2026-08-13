# authority/projection

`projectRunState` builds the operator-facing `RunView`: planning/execution/terminal
phase, suspension, current plan/candidate/publication, work status, open findings,
coverage counts, and terminal information. It is a synchronous read-only mapping.
Evolution and admission do not import it, and deleting/rebuilding the view cannot
change a later fold.
