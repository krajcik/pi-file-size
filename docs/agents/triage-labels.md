<!-- managed-by: veans-init -->
# Triage Labels

`veans` хранит labels с prefix `veans:`. В аргументах `--label`, `--label-add` и `--label-remove` используй короткое имя из второй колонки.

| Роль в mattpocock/skills | Аргумент veans | Label в Vikunja |
| --- | --- | --- |
| `bug` | `bug` | `veans:bug` |
| `enhancement` | `enhancement` | `veans:enhancement` |
| `needs-triage` | `needs-triage` | `veans:needs-triage` |
| `needs-info` | `needs-info` | `veans:needs-info` |
| `ready-for-agent` | `ready-for-agent` | `veans:ready-for-agent` |
| `ready-for-human` | `ready-for-human` | `veans:ready-for-human` |
| `wontfix` | `wontfix` | `veans:wontfix` |

После triage у задачи должна быть ровно одна category-role (`bug` или `enhancement`) и одна state-role из пяти остальных строк. При конфликте state-role остановись и запроси решение владельца.
