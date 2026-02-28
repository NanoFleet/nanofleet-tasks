import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
	addComment,
	createTask,
	deleteTask,
	getTask,
	getTaskAssignees,
	getTaskComments,
	getTaskResults,
	listTasks,
	updateTaskStatus,
} from './db';

const NANO_API_URL =
	process.env.NANO_API_URL ?? 'http://host.docker.internal:3000';
const NANO_INTERNAL_TOKEN = process.env.NANO_INTERNAL_TOKEN ?? '';

function nanoHeaders() {
	return {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${NANO_INTERNAL_TOKEN}`,
	};
}

// ---------------------------------------------------------------------------
// Push helpers
// ---------------------------------------------------------------------------

async function pushToAgent(agentId: string, content: string): Promise<void> {
	try {
		await fetch(`${NANO_API_URL}/internal/agents/${agentId}/messages`, {
			method: 'POST',
			headers: nanoHeaders(),
			body: JSON.stringify({ content }),
			signal: AbortSignal.timeout(5000),
		});
	} catch (err) {
		console.warn(`[tasks] Failed to push to agent ${agentId}:`, err);
	}
}

async function notifyAssignees(
	taskId: string,
	assigneeIds: string[],
	title: string,
	description: string | null,
): Promise<void> {
	const content = [
		`[New task assigned to you]`,
		`Title: ${title}`,
		description ? `Description: ${description}` : null,
		`taskId: ${taskId}`,
		``,
		`Use get_task("${taskId}") to see details, then update_task_status("${taskId}", "in_progress") when you start, and post_task_result("${taskId}", yourResult) when done.`,
	]
		.filter((l) => l !== null)
		.join('\n');

	await Promise.all(assigneeIds.map((id) => pushToAgent(id, content)));
}

async function notifyRejection(
	taskId: string,
	assigneeIds: string[],
	title: string,
	feedback: string,
): Promise<void> {
	const content = [
		`[Task returned for revision]`,
		`Title: ${title}`,
		`taskId: ${taskId}`,
		``,
		`Feedback: ${feedback}`,
		``,
		`Please revise and call post_task_result("${taskId}", yourResult) again when done.`,
	].join('\n');

	await Promise.all(assigneeIds.map((id) => pushToAgent(id, content)));
}

// ---------------------------------------------------------------------------
// Build enriched task list
// ---------------------------------------------------------------------------

function buildTaskList() {
	const tasks = listTasks();
	return tasks.map((task) => {
		const assignees = getTaskAssignees(task.id);
		const results = getTaskResults(task.id);
		const lastResult = results.at(-1) ?? null;
		return { ...task, assignees, lastResult };
	});
}

function buildTaskDetail(taskId: string) {
	const task = getTask(taskId);
	if (!task) return null;
	const assignees = getTaskAssignees(taskId);
	const comments = getTaskComments(taskId);
	const results = getTaskResults(taskId);
	return { ...task, assignees, comments, results };
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

export function createRestApp(): Hono {
	const app = new Hono();
	app.use('*', cors());

	// Serve frontend
	app.get('/', (_c) => {
		const html = Bun.file('/app/src/frontend/index.html');
		return new Response(html, { headers: { 'Content-Type': 'text/html' } });
	});

	// Proxy: list running agents from NanoFleet
	app.get('/agents', async (c) => {
		try {
			const res = await fetch(`${NANO_API_URL}/internal/agents`, {
				headers: nanoHeaders(),
				signal: AbortSignal.timeout(5000),
			});
			if (!res.ok) return c.json({ error: 'Failed to fetch agents' }, 502);
			const data = (await res.json()) as { agents: unknown[] };
			const running = (data.agents as Array<{ status: string }>).filter(
				(a) => a.status === 'running',
			);
			return c.json({ agents: running });
		} catch (err) {
			return c.json({ error: String(err) }, 500);
		}
	});

	// GET /tasks — list all tasks
	app.get('/tasks', (c) => {
		const tasks = buildTaskList();
		return c.json({ tasks });
	});

	// POST /tasks — create task
	app.post('/tasks', async (c) => {
		let body: { title?: string; description?: string; assigneeIds?: string[] };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid JSON' }, 400);
		}

		const { title, description, assigneeIds } = body;
		if (!title || !assigneeIds || assigneeIds.length === 0) {
			return c.json(
				{ error: 'title and at least one assigneeId are required' },
				400,
			);
		}

		const task = createTask(title, description ?? null, assigneeIds);

		// Fire-and-forget push to assignees
		notifyAssignees(task.id, assigneeIds, task.title, task.description).catch(
			(error) => { console.warn('Failed to notify assignees for task', task.id, error); },
		);

		return c.json({ task }, 201);
	});

	// GET /tasks/:id — task detail
	app.get('/tasks/:id', (c) => {
		const detail = buildTaskDetail(c.req.param('id'));
		if (!detail) return c.json({ error: 'Task not found' }, 404);
		return c.json({ task: detail });
	});

	// PATCH /tasks/:id/status — human approves or rejects
	app.patch('/tasks/:id/status', async (c) => {
		const taskId = c.req.param('id');
		const task = getTask(taskId);
		if (!task) return c.json({ error: 'Task not found' }, 404);

		let body: { action?: 'approve' | 'reject'; feedback?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid JSON' }, 400);
		}

		const { action, feedback } = body;
		if (action !== 'approve' && action !== 'reject') {
			return c.json({ error: 'action must be "approve" or "reject"' }, 400);
		}

		if (action === 'approve') {
			updateTaskStatus(taskId, 'done');
			addComment(
				taskId,
				'human',
				'human',
				'Human',
				'[System] Task approved and marked as done.',
			);
		} else {
			if (!feedback)
				return c.json({ error: 'feedback is required when rejecting' }, 400);
			updateTaskStatus(taskId, 'in_progress');
			addComment(taskId, 'human', 'human', 'Human', `[Feedback] ${feedback}`);

			// Notify assignees
			const assignees = getTaskAssignees(taskId);
			notifyRejection(taskId, assignees, task.title, feedback).catch(
				(error) => { console.warn('Failed to notify assignees for task', taskId, error); },
			);
		}

		const updated = buildTaskDetail(taskId);
		return c.json({ task: updated });
	});

	// POST /tasks/:id/comments — human adds comment
	app.post('/tasks/:id/comments', async (c) => {
		const taskId = c.req.param('id');
		if (!getTask(taskId)) return c.json({ error: 'Task not found' }, 404);

		let body: { content?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid JSON' }, 400);
		}

		if (!body.content) return c.json({ error: 'content is required' }, 400);

		const comment = addComment(taskId, 'human', 'human', 'Human', body.content);
		return c.json({ comment }, 201);
	});

	// DELETE /tasks/:id — delete task
	app.delete('/tasks/:id', (c) => {
		const deleted = deleteTask(c.req.param('id'));
		if (!deleted) return c.json({ error: 'Task not found' }, 404);
		return c.json({ ok: true });
	});

	return app;
}

// ---------------------------------------------------------------------------
// Start REST server on port 8820
// ---------------------------------------------------------------------------

export async function startRestApi(): Promise<void> {
	const app = createRestApp();

	Bun.serve({
		port: 8820,
		fetch: app.fetch,
	});

	console.log('[REST] Server listening on :8820');
}
