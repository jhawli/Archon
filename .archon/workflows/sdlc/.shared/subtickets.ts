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
 * old one (Entfällt). A lap that delivered nothing finishes none. `settleAndMove` does both
 * steps for release; the merge queue calls it with nothing delivered, so it closes no task.
 */
import { type Jira, movePath, type TaskRef, type TrackerConfig } from './jira.ts';

/** The feature a rest of `key` goes under: the parent of a slice. Null for anything else. */
export async function restFeature(jira: Jira, key: string): Promise<string | null> {
  const own = await jira.family(key);
  return own.type === jira.config.types.slice ? own.parent : null;
}

const TASK_NUMBER = /^Task (\d+):/;

export const taskNumber = (title: string): number => Number(TASK_NUMBER.exec(title)?.[1] ?? Number.NaN);

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
  if (delivers === 'all') return { done: open.map(child => child.key), rest: [], unknown };
  // Nothing delivered ('none', or no word from the review): no task is done, whatever it names.
  if (delivers !== 'part') return { done: [], rest: [], unknown: [] };
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
export async function subtaskType(jira: Jira): Promise<string> {
  const project = await jira.call('GET', `/rest/api/3/project/${jira.config.project}`);
  const types = Array.isArray(project?.issueTypes) ? (project.issueTypes as { id?: unknown; subtask?: unknown }[]) : [];
  const sub = types.find(type => type.subtask === true && typeof type.id === 'string');
  if (sub === undefined) throw new Error(`project ${jira.config.project} has no sub-task type`);
  return String(sub.id);
}

/**
 * Settles the tasks of `key` before it goes to Review or Staging (decision 5). `lap.delivers`
 * and `lap.tasks` are the review's word; `restKey` is the rest slice this lap filed, or null.
 * Returns lines for the lap's `Loop result:` comment and the tasks still open (`left`). Every
 * step may run twice: a task that is already done is left alone, and one already filed under
 * the rest (same title) is not filed again. Without a rest the tasks left over stay open, and
 * Jira keeps the slice off Review.
 */
export async function closeTasks(
  jira: Jira,
  key: string,
  lap: { readonly delivers: string; readonly tasks: readonly number[] },
  restKey: string | null
): Promise<{ notes: string[]; left: string[] }> {
  const s = jira.config.status;
  const own = await jira.family(key);
  const split = splitTasks(own.children, lap.tasks, lap.delivers, s);
  const notes: string[] = [];
  for (const task of split.done) await jira.move(task, s.taskDone);
  if (split.done.length > 0) notes.push(`Tasks erledigt: ${split.done.join(', ')}.`);
  const settled = new Set([...split.done, ...(restKey === null ? [] : split.rest)]);
  const left = own.children
    .filter(child => child.status !== s.taskDone && child.status !== s.taskDropped && !settled.has(child.key))
    .map(child => child.key);
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
  return { notes, left };
}

/**
 * CONC-176: the tasks of `key` the builder reported built and the review did not name done
 * (`named`), sent back to In Arbeit after a lap that delivered nothing. Returns a line for the
 * lap's `Loop result:` comment, none when no task moved. A move Jira refuses is named there and
 * the others still move: the tasks are bookkeeping, and the release goes on. A config without
 * the steps has no built task.
 */
export async function reopenBuilt(jira: Jira, key: string, named: readonly number[]): Promise<string[]> {
  const s = jira.config.status;
  if (s.taskProgress === undefined || s.taskBuilt === undefined) return [];
  const built = (await jira.family(key)).children.filter(
    child => child.status === s.taskBuilt && !named.includes(taskNumber(child.title))
  );
  const moved: string[] = [];
  const refused: string[] = [];
  for (const task of built) {
    try {
      await jira.move(task.key, s.taskProgress);
      moved.push(task.key);
    } catch (error) {
      refused.push(`${task.key} (${(error instanceof Error ? error.message : String(error)).slice(0, 200)})`);
    }
  }
  const notes: string[] = [];
  if (moved.length > 0) notes.push(`Zurück auf In Arbeit, gebaut, aber nicht in „Tasks done“: ${moved.join(', ')}.`);
  if (refused.length > 0) notes.push(`Bleibt auf Gebaut, Jira lässt In Arbeit nicht zu: ${refused.join(', ')}.`);
  return notes;
}

/**
 * After a lap (release) or a merge (merge queue): settle the tasks the review's word names when
 * the ticket goes on to Review or Staging (the merge queue passes none), then move it along the
 * lifecycle (`moveTo`). A slice whose tasks stay open
 * cannot pass Entwicklung → Review, so when its way leads there it stays where it is: the result names its status and
 * the open tasks (`left`), and the caller still writes its comment and asks the owner. A move
 * Jira refuses otherwise throws, with the notes of what was already settled.
 */
export async function settleAndMove(
  jira: Jira,
  key: string,
  current: string,
  to: string,
  lap: { readonly delivers: string; readonly tasks: readonly number[] },
  restKey: string | null
): Promise<{ status: string; notes: string[]; left: string[] }> {
  const s = jira.config.status;
  const onward = to === s.review || to === s.staging;
  const { notes, left } = onward ? await closeTasks(jira, key, lap, restKey) : { notes: [], left: [] };
  if (left.length > 0 && movePath(current, to, s).includes(s.review)) {
    notes.push('Mit offenen Tasks lässt Jira die Scheibe nicht auf Review: sie bleibt, wo sie ist.');
    return { status: current, notes, left };
  }
  try {
    await jira.moveTo(key, to);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(notes.length > 0 ? `${why} (${notes.join(' ')})` : why);
  }
  return { status: to, notes, left: [] };
}
