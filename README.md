# nanofleet-tasks

A [NanoFleet](https://github.com/NanoFleet/nanofleet) plugin that provides a Kanban task manager for human-agent collaboration. Create tasks, assign them to agents, review their results, and approve or reject with feedback.

## Features

- Kanban board with 4 columns: TODO → IN PROGRESS → REVIEW → DONE
- Assign tasks to one or multiple agents
- Agents receive notifications when assigned
- Agents submit results via MCP; humans approve or reject with feedback
- Rejected tasks return to IN PROGRESS with feedback sent back to the agent
- Shared filesystem for file-based task outputs

## MCP Tools

<details>
<summary><code>list_my_tasks</code> — List all tasks assigned to you</summary>

**Input:** none

**Response:**
```json
[{ "id": "...", "title": "Write a report", "status": "in_progress", ... }]
```

</details>

<details>
<summary><code>get_task</code> — Get full task details</summary>

**Input:**
```json
{ "taskId": "abc123" }
```

**Response:** Full task object including assignees, comments, and previous results.

</details>

<details>
<summary><code>update_task_status</code> — Update task status</summary>

**Input:**
```json
{ "taskId": "abc123", "status": "in_progress" }
```

`status` must be `"in_progress"` or `"review"`. Agents cannot set `"done"` — only humans can approve.

</details>

<details>
<summary><code>post_task_result</code> — Submit result and move to review</summary>

**Input:**
```json
{ "taskId": "abc123", "content": "Here is my analysis...", "filePath": "/shared/tasks/abc123/report.md" }
```

`filePath` is optional. Automatically sets status to `"review"`.

</details>

> **Critical rules for agents:**
> - Call `update_task_status(taskId, "in_progress")` as soon as you start working on a task
> - Use `post_task_result` when done — do **not** call `update_task_status("review")` separately
> - Save output files to `/shared/tasks/{taskId}/` and pass the path in `filePath`
> - You cannot set status to `"done"` — only the human can approve

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tasks` | List all tasks |
| `POST` | `/tasks` | Create a task `{ title, description?, assigneeIds[] }` |
| `GET` | `/tasks/:id` | Get full task detail (assignees, comments, results) |
| `DELETE` | `/tasks/:id` | Delete a task |
| `PATCH` | `/tasks/:id/status` | Approve or reject `{ action: "approve" \| "reject", feedback? }` |
| `POST` | `/tasks/:id/comments` | Add a human comment `{ content }` |
| `GET` | `/agents` | List running agents (proxy to NanoFleet) |

## Ports

| Port | Service |
|------|---------|
| `8820` | REST API + Web UI |
| `8821` | MCP server |

## Installation

Install via the NanoFleet Plugins page using the manifest URL:

```
https://raw.githubusercontent.com/NanoFleet/nanofleet-tasks/main/manifest.json
```

## Docker image

Built and pushed automatically to GHCR on every merge to `main`:

```
ghcr.io/nanofleet/nanofleet-tasks:latest
```
