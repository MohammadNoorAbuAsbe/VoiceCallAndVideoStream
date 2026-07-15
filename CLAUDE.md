<!-- eve:instructions:start version="1" -->

## EVE Product History

This repository uses EVE to record completed product work.

When you complete a coherent unit of product work, call the EVE
`complete_snapshot` tool before ending the task.

Create a Snapshot for work such as:

- A feature or user-visible improvement
- A bug fix
- A meaningful refactor
- A migration
- An experiment
- A release-related change

Do not create a Snapshot for trivial work such as:

- Formatting-only changes
- A variable rename with no behavior change
- Lint-only fixes
- Temporary debugging changes
- Work that was started but not completed

When no Snapshot is warranted, call `skip_snapshot` and include a short reason.

The Snapshot should reflect the completed task and include the relevant
behavior changes, validation, commits, screenshots, decisions, risks,
relationships, and session references when available.

<!-- eve:instructions:end -->
