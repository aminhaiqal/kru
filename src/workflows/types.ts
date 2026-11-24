import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,49}$/);
const position = z
  .object({ x: z.number().min(-5000).max(10000), y: z.number().min(-5000).max(10000) })
  .strict();
const nodeSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(70),
    type: z.enum(['trigger', 'agent', 'connector', 'set', 'if']),
    position,
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export const graphSchema = z
  .object({
    nodes: z.array(nodeSchema).min(1).max(30),
    edges: z
      .array(
        z
          .object({ from: id, to: id, port: z.enum(['main', 'true', 'false']).default('main') })
          .strict(),
      )
      .max(60),
  })
  .strict()
  .superRefine((graph, context) => {
    const ids = new Set(graph.nodes.map((node) => node.id));
    if (ids.size !== graph.nodes.length)
      context.addIssue({ code: 'custom', message: 'Node IDs must be unique' });
    const incoming = new Set<string>(),
      connections = new Set<string>();
    for (const edge of graph.edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to))
        context.addIssue({ code: 'custom', message: 'Connections must reference existing nodes' });
      if (incoming.has(edge.to))
        context.addIssue({ code: 'custom', message: 'Each node accepts one incoming connection' });
      incoming.add(edge.to);
      const source = graph.nodes.find((node) => node.id === edge.from),
        target = graph.nodes.find((node) => node.id === edge.to);
      if (
        target?.type === 'trigger' ||
        (source?.type === 'if' ? edge.port === 'main' : edge.port !== 'main')
      )
        context.addIssue({
          code: 'custom',
          message: 'Use a valid output port; triggers cannot have incoming connections',
        });
      const key = `${edge.from}:${edge.port}:${edge.to}`;
      if (connections.has(key))
        context.addIssue({ code: 'custom', message: 'Duplicate connection' });
      connections.add(key);
    }
    const visited = new Set<string>(),
      visiting = new Set<string>();
    const visit = (node: string): boolean => {
      if (visiting.has(node)) return false;
      if (visited.has(node)) return true;
      visiting.add(node);
      for (const edge of graph.edges.filter((edge) => edge.from === node))
        if (!visit(edge.to)) return false;
      visiting.delete(node);
      visited.add(node);
      return true;
    };
    if (graph.nodes.some((node) => !visit(node.id)))
      context.addIssue({ code: 'custom', message: 'Workflow cycles are not supported' });
  });
export const workflowSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000).default(''),
    agentId: z.string().min(1),
    graph: graphSchema,
    active: z.boolean().default(false),
    intervalMinutes: z.number().int().min(1).max(525600).nullable().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.active && !value.intervalMinutes)
      context.addIssue({ code: 'custom', message: 'Set an interval before activating a workflow' });
    if (Buffer.byteLength(JSON.stringify(value.graph)) > 48000)
      context.addIssue({ code: 'custom', message: 'Workflow configuration exceeds 48 KB' });
  });
export type Graph = z.infer<typeof graphSchema>;
export type Node = Graph['nodes'][number];
export interface DefinitionRow {
  id: string;
  agent_id: string;
  name: string;
  description: string;
  graph_json: string;
  active: number;
  interval_minutes: number | null;
  next_run_at: string | null;
  legacy_skill_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface RunRow {
  id: string;
  workflow_id: string;
  agent_id: string;
  name: string;
  graph_json: string;
  input_json: string;
  status: string;
  error: string | null;
  started_at: string;
  ended_at: string | null;
}
export interface NodeRow {
  id: string;
  run_id: string;
  node_id: string;
  status: string;
  input_json: string;
  output_json: string;
  binding_json: string | null;
  error: string | null;
  task_id: string | null;
  approval_id: string | null;
  started_at: string | null;
  ended_at: string | null;
}
export const starterGraph = (instructions = ''): Graph => ({
  nodes: [
    {
      id: 'start',
      name: 'When run manually',
      type: 'trigger',
      position: { x: 100, y: 200 },
      config: {},
    },
    {
      id: 'agent',
      name: 'Bot task',
      type: 'agent',
      position: { x: 410, y: 200 },
      config: {
        prompt: instructions || 'Summarize the input and report a useful result.',
        maxTurns: 8,
      },
    },
  ],
  edges: [{ from: 'start', to: 'agent', port: 'main' }],
});
