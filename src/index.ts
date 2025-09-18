import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BaseAdapter } from '@bull-board/api/dist/src/queueAdapters/base';
import { FastifyAdapter } from '@bull-board/fastify';
import fastify, { FastifyInstance, FastifyRequest } from 'fastify';
import { Server, IncomingMessage, ServerResponse } from 'http';
import { env } from './env';

import { createQueue, setupQueueProcessor } from './queue';

interface AddJobQueryString {
  id: string;
  targetUrl: string;
  runAt: string;
  method?: string;
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
  server.register(serverAdapter.registerPlugin(), {
    prefix: '/',
    basePath: '/',
  });

  server.get(
    '/add-job',
    {
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

  await server.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(
    `To schedule a job, run: curl "https://${env.RAILWAY_STATIC_URL}/add-job?id=1&targetUrl=https%3A%2F%2Fexample.com&runAt=17:34"`
  );
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
