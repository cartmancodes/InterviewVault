# Managing Long Running Tasks

> **Quick Reference** for [ManagingLongRunningTasks](../ManagingLongRunningTasks.md) — condensed cheat-sheet.

## Decision Triggers

- **Response time.** If work takes more than a few seconds and the caller can wait for the result, return a job ID and process it asynchronously.
- **Workload.** Video transcoding, image processing, PDF generation, bulk email, and CSV imports or exports are common examples.
- **Capacity.** Multiply the arrival rate by the average processing time to estimate how many jobs will run concurrently. Put GPU, CPU, or memory-intensive jobs on a worker fleet.
- **Operating cost.** Keep short requests synchronous when they fit the web tier. A background job adds a queue, workers, status tracking, retries, and monitoring.

## Request Flow

1. **Create the job.** The web server validates the request and saves a pending job record.
2. **Enqueue the job ID.** Keep the full job details in the database.
3. **Return the ID.** The client can check progress while the job runs.
4. **Claim the work.** A worker takes the message, fetches the job details, and marks the job as processing.
5. **Save the result.** The worker writes output files to object storage or saves result metadata in the database.
6. **Record the outcome.** Mark the job as completed or failed so clients can see its status or receive a notification.

## Core Components

### Queue Choice

![Kafka is the default interview pick unless constraints apply, with replay, fan-out, retention, huge volume, and partition ordering. Redis with Bull or BullMQ is startup-friendly with retries, delayed jobs, and priorities, but has memory-first durability tradeoffs. AWS SQS is managed and scalable with guaranteed delivery, but its 1 MB limit means passing IDs instead of full job data. RabbitMQ supports complex routing and enterprise workflows, but self-hosting adds cluster, upgrade, and disk monitoring work.](assets/aa3cd63cf82688fa-03e770112359060f.png)

- **Kafka**: Default interview pick unless constrained; replay, fan-out, retention, huge volume, partition ordering.
- **Redis with Bull/BullMQ**: Startup-friendly retries, delayed jobs, and priorities; memory-first durability tradeoff.
- **AWS SQS**: Managed scaling and delivery; 1 MB message limit means pass IDs, not full job data.
- **RabbitMQ**: Complex routing and enterprise workflows; self-hosting adds cluster, upgrade, disk monitoring.

### Worker Runtime

![Normal servers are the default for interviews, giving full control, easy debugging, and support for long jobs. Serverless functions autoscale and charge per execution, but have cold starts and minimal local storage. Container-based workers on Kubernetes or ECS are more complex than servers but more flexible than serverless.](assets/aa3cd63cf82688fa-5a438c22269cb65f.png)

- **Normal servers**: Default for interviews; full control, easy debugging, and support for long jobs.
- **Serverless functions**: Autoscale and pay per execution; constraints include cold starts and minimal local storage.
- **Container-based workers**: Kubernetes or ECS middle ground; more complex than servers, more flexible than serverless.

## Key Time Numbers

### Job Latency Reference

![Quick profile query takes less than 0.1 seconds. PDF report generation takes at least 45 seconds in the example.](assets/60907f54a7f51dd1-ee7fac8e8563dd44.png)

- **Profile fetch.** Less than 0.1 seconds in the synchronous example.
- **Annual report.** At least 45 seconds in the report generation example.

### Platform Timeout Constraints

![Web timeout limits are often 30 to 60 seconds. Function limit for serverless execution is 15 to 60 minutes depending on provider.](assets/3da8beb6c333950e-d9383574d80365b6.png)

- **Web timeout**: Web servers and load balancers often enforce 30-60 second limits.
- **Function limit**: Serverless executions are limited to 15-60 minutes, depending on provider.

### Operational Tuning Values

- **Worker failure detection.** The guide uses 10–30 seconds as a starting interval. Tune it to how long a job can wait for recovery after its worker stops responding.
- **Retry limit.** After 3–5 unsuccessful attempts, send the job to a dead-letter queue for investigation.

## Pitfalls and Fixes

![Worker crash is handled with heartbeats so the queue retries when the worker stops checking in. Duplicate work is prevented with idempotency keys that return the existing job ID. Queue overload is handled with depth limits and system busy responses. Mixed workloads need separate fast and slow queues to avoid blocking. Job dependencies can chain simple steps or use Step Functions, Temporal, or Airflow for complex workflows.](assets/aa3cd63cf82688fa-9b488e38ea32a608.png)

- **Worker crash**: Use heartbeats; queue retries the job when the worker stops checking in.
- **Duplicate work**: Use idempotency keys; return the existing job ID for the same operation.
- **Queue overload**: Set queue depth limits; reject with system busy instead of accepting doomed work.
- **Mixed workloads**: Separate fast and slow queues to prevent long jobs from blocking short jobs.
- **Job dependencies**: Chain simple steps; use Step Functions, Temporal, or Airflow for complex workflows.
