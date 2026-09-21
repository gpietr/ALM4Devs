-- Lets a run be abandoned (started, then explicitly given up on) instead of forcing every
-- open execution to either finish or sit "in_progress" forever - see
-- packages/core/src/test-cases.ts's abandonExecution.

alter table test_executions drop constraint if exists test_executions_status_check;
alter table test_executions add constraint test_executions_status_check
  check (status in ('in_progress', 'pass', 'fail', 'blocked', 'abandoned'));
