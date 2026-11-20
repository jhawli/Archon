/**
 * Rest tickets as slices, and the tasks of a slice (VAULT-28).
 *
 * A partial delivery files its rest as a new slice under the feature of the lap's slice, on
 * Startklar (AK17): `restFeature` names the feature, `createTicket` files and moves it. The
 * delivered slice goes on to Staging; nothing waits for the rest any more.
 *
 * A slice's tasks are its Jira sub-tasks, titled `Task <n>: …`. Jira lets a slice onto Review
 * only when no task is open, so before Review the lap settles them (`closeTasks`): a whole
 * delivery finishes every open one; a partial one finishes the tasks the review named
 * (`Tasks done: 1, 2`), and files the others again under the rest slice, dropping them on the
 * old one (Entfällt).
 */
import type { Jira, TaskRef, TrackerConfig } from './jira.ts';

/** The feature a rest of `key` goes under: the parent of a slice. Null for anything else. */
export async function restFeature(jira: Jira, key: string): Promise<string | null> {
  const own = await jira.family(key);
  return own.type === jira.config.types.slice ? own.parent : null;
}

const TASK_NUMBER = /^Task (\d+):/;

const taskNumber = (title: string): number => Number(TASK_NUMBER.exec(title)?.[1] ?? Number.NaN);

/** Which open tasks a lap finished and which are left for the rest. Pure: no call to Jira. */
export function splitTasks(
  children: readonly TaskRef[],
  named: readonly number[],
  delivers: string,
  s: TrackerConfig['status']
): { done: string[]; rest: string[]; unknown: number[] } {
  const open = children.filter(child => child.status !== s.taskDone && child.status !== s.taskDropped);
  const numbers = new Set(children.map(child => taskNumber(child.title)).filter(n => !Number.isNaN(n)));
  const unknown = named.filter(n => !numbers.has(n));
  if (delivers !== 'part') return { done: open.map(child => child.key), rest: [], unknown };
  const isNamed = (title: string): boolean => named.includes(taskNumber(title));
  return {
    done: open.filter(child => isNamed(child.title)).map(child => child.key),
    rest: open.filter(child => !isNamed(child.title)).map(child => child.key),
    unknown,
  };
}

/**
 * The task numbers in the review's line `Tasks done: 1, 2, 5` (`none` names none). Only up to a
 * `;`, and only numbers: whatever else the line carries is not read.
 */
export function tasksDone(text: string): number[] {
  const line = /^Tasks done:(.*)$/m.exec(text)?.[1] ?? '';
  return [...(line.split(';')[0] ?? '').matchAll(/\b(\d{1,3})\b/g)].map(m => Number(m[1]));
}

/** The project's sub-task type, read from Jira by its flag, never by its name. */
async function subtaskType(jira: Jira): Promise<string> {
  const project = await jira.call('GET', `/rest/api/3/project/${jira.config.project}`);
  const types = Array.isArray(project?.issueTypes) ? (project.issueTypes as { id?: unknown; subtask?: unknown }[]) : [];
  const sub = types.find(type => type.subtask === true && typeof type.id === 'string');
  if (sub === undefined) throw new Error(`project ${jira.config.project} has no sub-task type`);
  return String(sub.id);
}

/**
 * Settles the tasks of `key` before it goes to Review or Staging (decision 5). `lap.delivers`
 * and `lap.tasks` are the review's word; `restKey` is the rest slice this lap filed, or null.
 * Returns lines for the lap's `Loop result:` comment. Every step may run twice: a task that
 * is already done is left alone, and one already filed under the rest (same title) is not
 * filed again. Without a rest the tasks left over stay open, and Jira keeps the slice off Review.
 */
export async function closeTasks(
  jira: Jira,
  key: string,
  lap: { readonly delivers: string; readonly tasks: readonly number[] },
  restKey: string | null
): Promise<string[]> {
  const s = jira.config.status;
  const own = await jira.family(key);
  const split = splitTasks(own.children, lap.tasks, lap.delivers, s);
  const notes: string[] = [];
  for (const task of split.done) await jira.move(task, s.taskDone);
  if (split.done.length > 0) notes.push(`Tasks erledigt: ${split.done.join(', ')}.`);
  if (split.rest.length > 0 && restKey === null) {
    notes.push(`Offen ohne Rest-Ticket: ${split.rest.join(', ')}.`);
  } else if (split.rest.length > 0 && restKey !== null) {
    jira.issue(restKey);
    const there = new Set((await jira.family(restKey)).children.map(child => child.title));
    const type = await subtaskType(jira);
    for (const task of split.rest) {
      const title = own.children.find(child => child.key === task)?.title ?? task;
      if (!there.has(title)) {
        const old = await jira.call('GET', `${jira.issue(task)}?fields=description`);
        const description = (old?.fields as { description?: unknown } | undefined)?.description;
        await jira.call('POST', '/rest/api/3/issue', {
          fields: {
            project: { key: jira.config.project },
            issuetype: { id: type },
            parent: { key: restKey },
            summary: title,
            ...(description !== undefined && description !== null ? { description } : {}),
          },
        });
      }
      await jira.move(task, s.taskDropped);
    }
    notes.push(`Weiter in ${restKey}: ${split.rest.join(', ')}.`);
  }
  if (split.unknown.length > 0) {
    notes.push(`„Tasks done“ nennt ${split.unknown.join(', ')}: diese Nummer hat die Scheibe nicht, übergangen.`);
  }
  return notes;
}
