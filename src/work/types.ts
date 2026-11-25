import { z } from 'zod';

const stageSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
    name: z.string().trim().min(1).max(50),
    category: z.enum(['backlog', 'active', 'done']),
    agentId: z.string().nullable().default(null),
    instructions: z.string().max(3000).default(''),
  })
  .strict();
export const projectSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    key: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9]{1,7}$/)
      .optional(),
    description: z.string().default(''),
    stages: z.array(stageSchema).min(3).max(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.stages.map((s) => s.id)).size !== value.stages.length)
      ctx.addIssue({ code: 'custom', message: 'Stage ids must be unique' });
    if (
      ['backlog', 'active', 'done'].some(
        (category) => !value.stages.some((stage) => stage.category === category),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Include at least one status in To Do, In Progress, and Done',
      });
  });
export const workInputSchema = z
  .object({
    projectId: z.string().optional(),
    title: z.string().trim().min(1).max(160),
    description: z.string().max(12000).default(''),
    stageId: z.string().optional(),
    priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).default('medium'),
    assigneeId: z.string().nullable().default(null),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((value) => {
        const date = new Date(value + 'T00:00:00Z');
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
      }, 'Invalid date')
      .nullable()
      .default(null),
    labels: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
    criteria: z.string().max(4000).default(''),
    maxTurns: z.number().int().min(1).max(50).default(8),
  })
  .strict();
export type Stage = z.infer<typeof stageSchema>;
export interface ProjectRow {
  id: string;
  project_key: string;
  name: string;
  description: string;
  stages_json: string;
  files_json?: string;
  created_at: string;
  updated_at: string;
}
export interface WorkRow {
  id: string;
  project_id: string;
  number: number;
  title: string;
  description: string;
  stage_id: string;
  priority: string;
  assignee_id: string | null;
  due_date: string | null;
  labels_json: string;
  criteria: string;
  max_turns: number;
  task_id: string | null;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface RunRow {
  task_id: string;
  item_id: string;
  stage_id: string;
  settled_at: string | null;
  created_at: string;
}
export interface ActivityRow {
  id: string;
  item_id: string;
  kind: string;
  actor_id: string | null;
  body: string;
  metadata_json: string;
  occurred_at: string;
}
export const standardStages = (): Stage[] => [
  { id: 'brief', name: 'To Do', category: 'backlog', agentId: null, instructions: '' },
  { id: 'in_progress', name: 'In Progress', category: 'active', agentId: null, instructions: '' },
  { id: 'done', name: 'Done', category: 'done', agentId: null, instructions: '' },
];
