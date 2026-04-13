import { randomUUID } from "node:crypto";
import { z } from "zod";

export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type Task = {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  createdAt: string; // ISO
  updatedAt: string; // ISO
};

// Input schemas
export const taskCreateSchema = z.object({
  subject: z.string().min(1),
  description: z.string().default(""),
});

export const taskListSchema = z.object({
  status: z
    .enum(["pending", "in_progress", "completed", "cancelled"])
    .optional(),
});

export const taskGetSchema = z.object({
  id: z.string().min(1),
});

export const taskUpdateSchema = z.object({
  id: z.string().min(1),
  status: z
    .enum(["pending", "in_progress", "completed", "cancelled"])
    .optional(),
  subject: z.string().optional(),
  description: z.string().optional(),
});

export class TaskStore {
  private tasks: Map<string, Task> = new Map();

  create(input: z.infer<typeof taskCreateSchema>): { ok: true; task: Task } {
    const parsed = taskCreateSchema.parse(input);
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      subject: parsed.subject,
      description: parsed.description,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    return { ok: true, task };
  }

  list(input: z.infer<typeof taskListSchema>): { ok: true; tasks: Task[] } {
    const parsed = taskListSchema.parse(input);
    let tasks = Array.from(this.tasks.values());
    if (parsed.status !== undefined) {
      tasks = tasks.filter((t) => t.status === parsed.status);
    }
    // Sort oldest first by createdAt
    tasks.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    return { ok: true, tasks };
  }

  get(
    input: z.infer<typeof taskGetSchema>,
  ): { ok: true; task: Task } | { ok: false; error: string } {
    const parsed = taskGetSchema.parse(input);
    const task = this.tasks.get(parsed.id);
    if (!task) {
      return { ok: false, error: `Task not found: ${parsed.id}` };
    }
    return { ok: true, task };
  }

  update(
    input: z.infer<typeof taskUpdateSchema>,
  ): { ok: true; task: Task } | { ok: false; error: string } {
    const parsed = taskUpdateSchema.parse(input);
    const task = this.tasks.get(parsed.id);
    if (!task) {
      return { ok: false, error: `Task not found: ${parsed.id}` };
    }
    const updated: Task = {
      ...task,
      ...(parsed.status !== undefined ? { status: parsed.status } : {}),
      ...(parsed.subject !== undefined ? { subject: parsed.subject } : {}),
      ...(parsed.description !== undefined
        ? { description: parsed.description }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(updated.id, updated);
    return { ok: true, task: updated };
  }

  clear(): void {
    this.tasks.clear();
  }
}

// Default singleton for the process
export const defaultTaskStore: TaskStore = new TaskStore();
