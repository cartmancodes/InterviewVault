# Multi-step Processes

> **Quick Reference** for [Multi-StepProcesses](../Multi-StepProcesses.md) — condensed cheat-sheet.

## Interview Fit

### Use When

Flow-chart logic with state and many failures is a workflow candidate.

Driver acceptance, warehouse picking, and document signing are workflow candidates.

"If X fails, undo Y" or "all steps or none" is a workflow signal.

### Avoid When

Image resize or send email alone does not need a workflow engine.

If the client waits for the response, workflows usually add too much async overhead.

Most CRUD, single-service, and high-frequency low-value operations do not justify engine cost.

## Coordination Choices

![Saga Pattern uses local commits and unwinds earlier effects on later failure; Event-Driven Choreography uses durable-log events and works for mid-complexity but hides the flow; Workflow Orchestration uses one coordinator and fits complex flows needing control and visibility; Two-Phase Commit is a poor fit for long workflows because locks wait on the slowest participant and external systems may not support it.](assets/aa3cd63cf82688fa-d11c2c01197b3b54.png)

- **Saga Pattern**: Sequence of local commits; if a later step fails, unwind earlier effects.
- **Event-Driven Choreography**: Workers react to durable-log events; good mid-complexity, but flow is implicit.
- **Workflow Orchestration**: Single coordinator owns the sequence; best for complex flows needing control and visibility.
- **Two-Phase Commit**: Poor fit for long workflows: locks wait on slowest participant and external systems may not support it.

## Engine Choices

![Temporal is the most powerful open-source option with code-driven workflows, long waits, full history, and self-operation or Temporal Cloud; AWS Step Functions is a managed serverless state machine with standard runs capped at one year and 256KB between states; Durable Functions is an Azure cloud-native option that is easier to operate than Temporal but less flexible; Google Cloud Workflows is a cloud-native option similar to Durable Functions; Apache Airflow is strong for scheduled batch ETL but weaker for user-facing long-running workflows.](assets/aa3cd63cf82688fa-25fc928e58a3d361.png)

- **Temporal**: Most powerful open-source option; code-driven workflows, long waits, full history, operate it or use Temporal Cloud.
- **AWS Step Functions**: Managed serverless state machines; standard runs cap at one year and 256KB between states.
- **Durable Functions**: Azure cloud-native option; easier to operate than Temporal but less flexible.
- **Google Cloud Workflows**: Cloud-native option similar to Durable Functions; easier ops than Temporal but less flexible.
- **Apache Airflow**: Great for scheduled batch ETL; less suitable for user-facing long-running workflows.

## Durable Mechanics

![Workflow is deterministic high-level flow that must replay the same from inputs and history; Activity is one side-effecting step such as a service call, card charge, database read, or email; History Database is an append-only log of workflow decisions and Activity results; Replay recovers by re-executing from the top and returning recorded Activity results without re-running them; Temporal Server hands out tasks, tracks timeouts, records progress, and never runs your code.](assets/aa3cd63cf82688fa-872350d7e5787af7.png)

- **Workflow**: Deterministic high-level flow; decisions must replay the same from inputs and history.
- **Activity**: One side-effecting step, such as a service call, card charge, database read, or email.
- **History Database**: Append-only log of workflow decisions and Activity results that survives crashes.
- **Replay**: Recovery re-executes from the top; recorded Activity results return without re-running.
- **Temporal Server**: Hands out tasks, tracks timeouts, and records progress; it never runs your code.

## Workflow Updates

![Workflow Versioning keeps old executions on old code and new executions on new code, which is simple but not immediate; Workflow Migrations update the definition in place so running executions can pick up the change; patched() is a deterministic branch where old histories stay legacy and new arrivals run new behavior; Step Functions Pinning keeps running executions on their starting definition and applies updates only to new executions.](assets/aa3cd63cf82688fa-1b807353eae0790d.png)

- **Workflow Versioning**: Old executions run old code, new executions run new code; simplest but not immediate.
- **Workflow Migrations**: Update definition in place so running executions can pick up the change.
- **patched()**: Deterministic branch: old histories stay legacy, new arrivals at the point run new behavior.
- **Step Functions Pinning**: Running executions stay on starting definition; updates affect only new executions.

## Failure Handling

### Primitive Pitfalls

![In-Memory Progress loses what happened after a crash unless progress is persisted outside the host; Callback Routing means a webhook may hit a different API server, so load persisted state or wake the workflow by ID; Manual State Machines leave database rows passive and lead to hand-rolled pollers, locks, retries, and claiming.](assets/aa3cd63cf82688fa-a16108e18ff99b7f.png)

- **In-Memory Progress**: Crash after a commit loses what happened; persist progress outside the host.
- **Callback Routing**: Webhook may hit a different API server; load persisted state or wake the workflow by ID.
- **Manual State Machines**: Database rows do not act; hand-rolled pollers, locks, retries, and claiming follow.

### Deep Dive Fixes

![Compensating Actions undo committed steps in reverse and need retries and idempotency too; Idempotency Key records IN_PROGRESS before and COMPLETED after irreversible work and reconciles uncertain cases; Signals wake workflows by ID without holding a thread or worker memory; Continue-as-New starts a fresh run with current state and empty history; Activity Payloads should pass identifiers instead of huge inputs and results to keep history small.](assets/aa3cd63cf82688fa-404958fc757490a2.png)

- **Compensating Actions**: Undo committed steps in reverse; refunds and releases need retries and idempotency too.
- **Idempotency Key**: Record IN_PROGRESS before and COMPLETED after; reconcile uncertain cases instead of re-firing.
- **Signals**: External events wake the workflow by ID; waiting holds no thread or worker memory.
- **Continue-as-New**: Start a fresh run with current state and empty history; resumes at current position.
- **Activity Payloads**: Pass identifiers instead of huge inputs/results to keep workflow history small.

---
*Source: [https://www.hellointerview.com/learn/system-design/patterns/multi-step-processes/quick-reference](https://www.hellointerview.com/learn/system-design/patterns/multi-step-processes/quick-reference)*
