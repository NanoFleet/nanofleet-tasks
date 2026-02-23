import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import {
  addComment,
  addTaskResult,
  getTask,
  getTaskAssignees,
  getTaskComments,
  getTaskResults,
  getTasksForAgent,
  updateTaskStatus,
} from './db';

// Stores the calling agentId for the duration of each MCP request
const agentIdStorage = new AsyncLocalStorage<string>();

export function getCallerAgentId(): string {
  return agentIdStorage.getStore() ?? 'unknown';
}

const NANO_API_URL = process.env.NANO_API_URL ?? 'http://host.docker.internal:3000';
const NANO_INTERNAL_TOKEN = process.env.NANO_INTERNAL_TOKEN ?? '';

async function getAgentName(agentId: string): Promise<string> {
  try {
    const res = await fetch(`${NANO_API_URL}/internal/agents/${agentId}`, {
      headers: { Authorization: `Bearer ${NANO_INTERNAL_TOKEN}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return agentId;
    const data = (await res.json()) as { agent?: { name?: string } };
    return data.agent?.name ?? agentId;
  } catch {
    return agentId;
  }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'nanofleet-tasks',
    version: '0.0.1',
  });

  // --- tool: list_my_tasks ---
  server.tool(
    'list_my_tasks',
    'Returns all tasks assigned to the calling agent (all statuses).',
    {},
    async () => {
      const agentId = getCallerAgentId();
      const tasks = getTasksForAgent(agentId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ tasks }) }],
      };
    }
  );

  // --- tool: get_task ---
  server.tool(
    'get_task',
    'Returns full task details including comments and results.',
    {
      taskId: z.string().describe('The ID of the task'),
    },
    async ({ taskId }) => {
      const task = getTask(taskId);
      if (!task) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Task not found' }) }],
          isError: true,
        };
      }

      const assignees = getTaskAssignees(taskId);
      const comments = getTaskComments(taskId);
      const results = getTaskResults(taskId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ task, assignees, comments, results }),
          },
        ],
      };
    }
  );

  // --- tool: update_task_status ---
  server.tool(
    'update_task_status',
    'Update the status of a task. Agents can only set "in_progress" or "review". Use this when you start working (in_progress) or want human review (review). Do NOT call this separately when using post_task_result — it automatically sets status to review.',
    {
      taskId: z.string().describe('The ID of the task'),
      status: z.enum(['in_progress', 'review']).describe('"in_progress" when you start, "review" to request human review'),
    },
    async ({ taskId, status }) => {
      const agentId = getCallerAgentId();
      const task = getTask(taskId);

      if (!task) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Task not found' }) }],
          isError: true,
        };
      }

      const assignees = getTaskAssignees(taskId);
      if (!assignees.includes(agentId)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'You are not assigned to this task' }) }],
          isError: true,
        };
      }

      updateTaskStatus(taskId, status);

      const agentName = await getAgentName(agentId);
      const statusLabel = status === 'in_progress' ? 'started working on this task' : 'submitted this task for review';
      addComment(taskId, agentId, 'agent', agentName, `[System] ${agentName} ${statusLabel}.`);

      return {
        content: [{ type: 'text', text: JSON.stringify({ taskId, status, ok: true }) }],
      };
    }
  );

  // --- tool: post_task_result ---
  server.tool(
    'post_task_result',
    'Submit your result for a task and automatically move it to review. Call this when you are done with the task.',
    {
      taskId: z.string().describe('The ID of the task'),
      content: z.string().describe('Your result text / summary of what you did'),
      filePath: z.string().optional().describe('Optional: path to a file you wrote under /shared/tasks/{taskId}/'),
    },
    async ({ taskId, content, filePath }) => {
      const agentId = getCallerAgentId();
      const task = getTask(taskId);

      if (!task) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Task not found' }) }],
          isError: true,
        };
      }

      const assignees = getTaskAssignees(taskId);
      if (!assignees.includes(agentId)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'You are not assigned to this task' }) }],
          isError: true,
        };
      }

      // Save result
      const result = addTaskResult(taskId, agentId, content, filePath ?? null);

      // Move to review
      updateTaskStatus(taskId, 'review');

      // Add system comment
      const agentName = await getAgentName(agentId);
      addComment(
        taskId,
        agentId,
        'agent',
        agentName,
        `[System] ${agentName} submitted a result${filePath ? ` (file: ${filePath})` : ''}. Task is now in review.`
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ resultId: result.id, taskId, status: 'review', ok: true }),
          },
        ],
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Start MCP HTTP server on port 8821
// ---------------------------------------------------------------------------

export async function startMcpServer(): Promise<void> {
  const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; agentId: string }>();

  Bun.serve({
    port: 8821,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== '/mcp') {
        return new Response('Not found', { status: 404 });
      }

      const agentIdFromUrl = url.searchParams.get('agent_id') ?? 'unknown';
      const sessionId = req.headers.get('mcp-session-id');

      if (req.method === 'DELETE' && sessionId) {
        sessions.delete(sessionId);
        return new Response(null, { status: 204 });
      }

      if (sessionId && sessions.has(sessionId)) {
        const { transport, agentId: sessionAgentId } = sessions.get(sessionId)!;
        return agentIdStorage.run(sessionAgentId, () => transport.handleRequest(req));
      }

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, agentId: agentIdFromUrl });
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };

      const server = createMcpServer();
      await server.connect(transport);

      return agentIdStorage.run(agentIdFromUrl, () => transport.handleRequest(req));
    },
  });

  console.log('[MCP] Server listening on :8821');
}
