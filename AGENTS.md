<!-- veans-tracker:start -->
## Локальный Issue Tracker

- Этот репозиторий использует локальную Vikunja через `veans`; `.veans.yml` задаёт project и Kanban view.
- Перед `to-spec`, `to-tickets`, `triage`, `wayfinder` и другими issue-workflows прочитай `docs/agents/issue-tracker.md`, затем выполни `veans prime`.
- Используй labels из `docs/agents/triage-labels.md`; не создавай параллельные issue-файлы в `.scratch/`.
<!-- veans-tracker:end -->

## Agent skills

### Issue tracker

Issues live in the local Vikunja project `pi` and are managed through `veans`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical triage role mapping. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository with a root glossary and root ADR directory. See `docs/agents/domain.md`.
