/**
 * How many pull requests this batch merged, from the run's records (merge-action writes one per
 * merge GitHub confirmed). It runs after the merge group however that ended, and clears a
 * `deployment.md` an agent may have left: only the deploy block after it writes one.
 */
import { clearDeployment, runState } from '../../.shared/claims.ts';
import { artifactsDir, emit } from '../../.shared/io.ts';
import { readMerges } from '../../.shared/queue-status.ts';

clearDeployment(artifactsDir());
emit({ count: String(readMerges(runState()).length) });
