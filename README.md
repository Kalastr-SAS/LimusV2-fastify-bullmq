# BullMQ with BullBoard

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template/odzp-I)

## ✨ Features

- A queueing system with BullMQ and Redis
- A dashboard built with `bull-board`
- A Fastify server to trigger jobs via an `/add-job` API endpoint
- Outgoing requests include an `Authorization: Bearer <JWT>` header

## API: Schedule an HTTP Call

`GET /add-job`

Schedule a single HTTP request that the worker will execute at a specific time. Parameters are provided via the query string.

| Query | Required | Description |
| --- | --- | --- |
| `id` | yes | Identifier used in the job name (`HttpCall-{id}`). |
| `targetUrl` | yes | Fully qualified URL to call (supports `http` and `https`). |
| `runAt` | yes | Either `HH:mm` (24h) to run at the next occurrence of that time, or an ISO 8601 datetime string. |
| `method` | no | HTTP verb to use when calling `targetUrl`. Defaults to `GET`; accepts `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. |

### Example: call at 17:34 today

```bash
yarn start &
# Wait for the server to be ready, then:
curl "http://localhost:${PORT}/add-job?id=signup-1734&targetUrl=http://localhost:3000/user/audience/send-signup-emails&runAt=17:34&method=POST"
```

The response confirms the scheduled timestamp:

```json
{"ok": true, "scheduledFor": "2024-05-02T15:34:00.000Z"}
```

### Worker behaviour

Jobs run on `ScheduledHttpQueue`. At the scheduled time the worker:

- logs `Calling {METHOD} {URL}` before dispatching;
- performs the HTTP request with Node's native clients;
- adds headers:
  - `Authorization: Bearer ${JWT_CRON}`
  - `User-Agent: limus-queue-runner/1.0`
- resolves the job when the response status is in the 2xx range, otherwise the job fails with an error containing the response body.

Completed jobs are removed automatically (`removeOnComplete: true`).

### Verification

To ensure the service is ready before scheduling:

```bash
yarn build
yarn start
```

Once the server is running, execute the `curl` example above and observe the job in the Bull Board UI.

## Environment variables

Set the following variables (e.g. in a `.env` used by your process manager):

- `REDISHOST` — Redis host
- `REDISPORT` — Redis port
- `REDISUSER` — Redis username
- `REDISPASSWORD` — Redis password
- `PORT` — HTTP port for the Fastify server (default 3000 in dev)
- `RAILWAY_STATIC_URL` — Public URL for UI hints (default http://localhost:3000 in dev)
- `JWT_CRON` — JWT secret that will be sent as `Authorization: Bearer <JWT_CRON>` on all scheduled HTTP requests
