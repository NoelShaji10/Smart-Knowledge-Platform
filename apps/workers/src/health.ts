import { checkJobsHealth } from '@knowledge/jobs';
import { checkDatabaseHealth } from '@knowledge/database';

export async function checkWorkersHealth() {
  const [jobs, db] = await Promise.all([
    checkJobsHealth(),
    checkDatabaseHealth(),
  ]);

  return {
    healthy: jobs.healthy && db.healthy,
    components: { jobs, db },
  };
}
