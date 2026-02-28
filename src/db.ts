import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

const DB_PATH = '/data/nanofleet-tasks.db';

let db: Database;

export function getDb(): Database {
	if (!db) {
		db = new Database(DB_PATH);
		db.exec('PRAGMA journal_mode=WAL;');
		db.exec('PRAGMA foreign_keys=ON;');
		initSchema();
	}
	return db;
}

function initSchema() {
	db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_assignees (
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      PRIMARY KEY (task_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_type TEXT NOT NULL,
      author_name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_results (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      file_path TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}

// Task status type
export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done';

// Row types
export interface TaskRow {
	id: string;
	title: string;
	description: string | null;
	status: TaskStatus;
	created_at: number;
	updated_at: number;
}

export interface TaskAssigneeRow {
	task_id: string;
	agent_id: string;
}

export interface TaskCommentRow {
	id: string;
	task_id: string;
	author_id: string;
	author_type: 'agent' | 'human';
	author_name: string;
	content: string;
	created_at: number;
}

export interface TaskResultRow {
	id: string;
	task_id: string;
	agent_id: string;
	content: string;
	file_path: string | null;
	created_at: number;
}

// ---- Tasks ----

export function createTask(
	title: string,
	description: string | null,
	assigneeIds: string[],
): TaskRow {
	const db = getDb();
	const id = randomUUID();
	const now = Date.now();

	db.run(
		'INSERT INTO tasks (id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
		[id, title, description ?? null, 'todo', now, now],
	);

	for (const agentId of assigneeIds) {
		db.run('INSERT INTO task_assignees (task_id, agent_id) VALUES (?, ?)', [
			id,
			agentId,
		]);
	}

	return {
		id,
		title,
		description: description ?? null,
		status: 'todo',
		created_at: now,
		updated_at: now,
	};
}

export function listTasks(): TaskRow[] {
	return getDb()
		.query('SELECT * FROM tasks ORDER BY created_at DESC')
		.all() as TaskRow[];
}

export function getTask(id: string): TaskRow | null {
	return (
		(getDb().query('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow) ??
		null
	);
}

export function updateTaskStatus(id: string, status: TaskStatus): boolean {
	const result = getDb().run(
		'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
		[status, Date.now(), id],
	);
	return result.changes > 0;
}

export function deleteTask(id: string): boolean {
	const db = getDb();
	db.run('DELETE FROM task_assignees WHERE task_id = ?', [id]);
	db.run('DELETE FROM task_comments WHERE task_id = ?', [id]);
	db.run('DELETE FROM task_results WHERE task_id = ?', [id]);
	const result = db.run('DELETE FROM tasks WHERE id = ?', [id]);
	return result.changes > 0;
}

// ---- Assignees ----

export function getTaskAssignees(taskId: string): string[] {
	const rows = getDb()
		.query('SELECT agent_id FROM task_assignees WHERE task_id = ?')
		.all(taskId) as { agent_id: string }[];
	return rows.map((r) => r.agent_id);
}

export function getTasksForAgent(agentId: string): TaskRow[] {
	return getDb()
		.query(
			'SELECT t.* FROM tasks t JOIN task_assignees ta ON t.id = ta.task_id WHERE ta.agent_id = ? ORDER BY t.created_at DESC',
		)
		.all(agentId) as TaskRow[];
}

// ---- Comments ----

export function addComment(
	taskId: string,
	authorId: string,
	authorType: 'agent' | 'human',
	authorName: string,
	content: string,
): TaskCommentRow {
	const id = randomUUID();
	const now = Date.now();
	getDb().run(
		'INSERT INTO task_comments (id, task_id, author_id, author_type, author_name, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
		[id, taskId, authorId, authorType, authorName, content, now],
	);
	return {
		id,
		task_id: taskId,
		author_id: authorId,
		author_type: authorType,
		author_name: authorName,
		content,
		created_at: now,
	};
}

export function getTaskComments(taskId: string): TaskCommentRow[] {
	return getDb()
		.query(
			'SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC',
		)
		.all(taskId) as TaskCommentRow[];
}

// ---- Results ----

export function addTaskResult(
	taskId: string,
	agentId: string,
	content: string,
	filePath: string | null,
): TaskResultRow {
	const id = randomUUID();
	const now = Date.now();
	getDb().run(
		'INSERT INTO task_results (id, task_id, agent_id, content, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?)',
		[id, taskId, agentId, content, filePath ?? null, now],
	);
	return {
		id,
		task_id: taskId,
		agent_id: agentId,
		content,
		file_path: filePath ?? null,
		created_at: now,
	};
}

export function getTaskResults(taskId: string): TaskResultRow[] {
	return getDb()
		.query(
			'SELECT * FROM task_results WHERE task_id = ? ORDER BY created_at ASC',
		)
		.all(taskId) as TaskResultRow[];
}

export function getLatestResultPerAgent(taskId: string): TaskResultRow[] {
	return getDb()
		.query(`
      SELECT * FROM task_results
      WHERE task_id = ?
      AND id IN (
        SELECT id FROM task_results tr2
        WHERE tr2.task_id = task_results.task_id AND tr2.agent_id = task_results.agent_id
        ORDER BY created_at DESC LIMIT 1
      )
      ORDER BY created_at ASC
    `)
		.all(taskId) as TaskResultRow[];
}
