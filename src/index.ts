import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BaseAdapter } from '@bull-board/api/dist/src/queueAdapters/base';
import { FastifyAdapter } from '@bull-board/fastify';
import fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Server, IncomingMessage, ServerResponse } from 'http';
import { env } from './env';

import { createQueue, setupQueueProcessor } from './queue';

interface AddJobQueryString {
  id: string;
  targetUrl: string;
  runAt: string;
  method?: string;
}

interface DeleteJobQueryString {
  id: string;
}

const run = async () => {
  const scheduledHttpQueue = createQueue('ScheduledHttpQueue');
  await setupQueueProcessor(scheduledHttpQueue.name);

  const server: FastifyInstance<Server, IncomingMessage, ServerResponse> =
    fastify();

  const serverAdapter = new FastifyAdapter();
  createBullBoard({
    queues: [
      // Cast required while bull-board updates its types for BullMQ v5.
      new BullMQAdapter(scheduledHttpQueue) as unknown as BaseAdapter,
    ],
    serverAdapter,
  });
  serverAdapter.setBasePath('/');

  // Basic Auth for Bull Board dashboard
  const requireDashboardAuth = async (
    req: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Basic ')) {
      reply.header('WWW-Authenticate', 'Basic realm="Bull Board", charset="UTF-8"');
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const user = sep >= 0 ? decoded.slice(0, sep) : '';
      const pass = sep >= 0 ? decoded.slice(sep + 1) : '';

      if (user !== env.DASHBOARD_USER || pass !== env.DASHBOARD_PASSWORD) {
        reply.header('WWW-Authenticate', 'Basic realm="Bull Board", charset="UTF-8"');
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }
    } catch {
      reply.header('WWW-Authenticate', 'Basic realm="Bull Board", charset="UTF-8"');
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
  };

  // Register Bull Board behind the Basic Auth guard (scoped plugin)
  server.register(
    async (instance) => {
      instance.addHook('onRequest', requireDashboardAuth);
      instance.register(serverAdapter.registerPlugin(), {
        prefix: '/',
        basePath: '/',
      });
    },
    { prefix: '/' }
  );

  // Simple API key guard for protected endpoints
  const requireApiKey = async (
    req: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> => {
    const headerApiKey = (req.headers['x-api-key'] as string | undefined) ??
      (typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : undefined);

    if (!headerApiKey || headerApiKey !== env.API_KEY_SCHEDULER) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
  };

  server.get(
    '/add-job',
    {
      preHandler: requireApiKey,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            targetUrl: { type: 'string', format: 'uri' },
            runAt: { type: 'string' },
            method: { type: 'string' },
          },
          required: ['id', 'targetUrl', 'runAt'],
        },
      },
    },
    (req: FastifyRequest<{ Querystring: AddJobQueryString }>, reply) => {
      if (req.query == null) {
        reply.code(400).send({ error: 'Missing query parameters' });

        return;
      }

      const { id, targetUrl, runAt } = req.query;
      const method = (req.query.method ?? 'GET').toUpperCase();

      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        reply.code(400).send({ error: `Unsupported HTTP method ${method}` });

        return;
      }

      let runAtDate: Date | null = null;

      if (/^\d{2}:\d{2}$/.test(runAt)) {
        const [hoursStr, minutesStr] = runAt.split(':');
        const hours = Number.parseInt(hoursStr, 10);
        const minutes = Number.parseInt(minutesStr, 10);

        if (
          Number.isNaN(hours) ||
          Number.isNaN(minutes) ||
          hours < 0 ||
          hours > 23 ||
          minutes < 0 ||
          minutes > 59
        ) {
          reply.code(400).send({ error: 'runAt must be a valid HH:mm time string' });

          return;
        }

        runAtDate = new Date();
        runAtDate.setSeconds(0, 0);
        runAtDate.setHours(hours, minutes, 0, 0);

        if (runAtDate.getTime() <= Date.now()) {
          runAtDate.setDate(runAtDate.getDate() + 1);
        }
      } else {
        const parsedDate = new Date(runAt);
        if (!Number.isNaN(parsedDate.getTime())) runAtDate = parsedDate;
      }

      if (runAtDate == null) {
        reply.code(400).send({ error: 'runAt must be either HH:mm or an ISO8601 date string' });

        return;
      }

      const delay = runAtDate.getTime() - Date.now();

      if (delay <= 0) {
        reply.code(400).send({ error: 'runAt must be in the future' });

        return;
      }

      scheduledHttpQueue.add(
        `HttpCall-${id}`,
        { targetUrl, method },
        {
          delay,
          removeOnComplete: true,
        }
      );

      reply.send({
        ok: true,
        scheduledFor: runAtDate.toISOString(),
      });
    }
  );

  // Remove a scheduled job by id (matches the id used in the job name)
  server.get(
    '/delete-job',
    {
      preHandler: requireApiKey,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
      },
    },
    async (req: FastifyRequest<{ Querystring: DeleteJobQueryString }>, reply) => {
      if (req.query == null) {
        reply.code(400).send({ error: 'Missing query parameters' });
        return;
      }

      const { id } = req.query;
      const jobName = `HttpCall-${id}`;

      const jobTypes = [
        'delayed',
        'waiting',
        'paused',
        'prioritized',
        'waiting-children',
      ] as const;

      const jobs = await scheduledHttpQueue.getJobs(jobTypes as any, 0, -1, true);
      const matches = jobs.filter((j) => j.name === jobName);

      let removed = 0;
      let failed = 0;

      for (const job of matches) {
        try {
          // Note: active jobs cannot be removed; this may throw.
          await job.remove();
          removed += 1;
        } catch {
          failed += 1;
        }
      }

      if (removed === 0 && failed === 0) {
        reply.code(404).send({ ok: false, message: 'No matching job found' });
        return;
      }

      reply.send({ ok: true, removed, failed });
    }
  );

  await server.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(
    `To schedule a job, run: curl "https://${env.RAILWAY_STATIC_URL}/add-job?id=1&targetUrl=https%3A%2F%2Fexample.com&runAt=17:34"`
  );
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
