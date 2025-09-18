import { ConnectionOptions, Queue, Worker } from 'bullmq';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

import { env } from './env';

const connection: ConnectionOptions = {
  host: env.REDISHOST,
  port: env.REDISPORT,
  username: env.REDISUSER,
  password: env.REDISPASSWORD,
};

export const createQueue = (name: string) => new Queue(name, { connection });

interface ScheduledHttpJobData {
  targetUrl: string;
  method: string;
}

const performHttpCall = async ({ targetUrl, method }: ScheduledHttpJobData) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(targetUrl);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? httpsRequest : httpRequest;

    const request = client(
      {
        method,
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        port: url.port || (isHttps ? 443 : 80),
      },
      (response) => {
        response.setEncoding('utf8');
        let body = '';

        response.on('data', (chunk) => {
          body += chunk;
        });

        response.on('end', () => {
          const status = response.statusCode ?? 0;

          if (status >= 200 && status < 300) {
            resolve({ status, body });
          } else {
            reject(new Error(`Request failed with status ${status}: ${body}`));
          }
        });
      }
    );

    request.on('error', reject);
    request.end();
  });

export const setupQueueProcessor = async (queueName: string) => {
  const worker = new Worker(
    queueName,
    async (job) => {
      const jobData = job.data as ScheduledHttpJobData;

      await job.log(`Calling ${jobData.method} ${jobData.targetUrl}`);

      const result = await performHttpCall(jobData);

      await job.log(`Call completed with status ${result.status}`);

      return {
        jobId: job.id,
        status: result.status,
        body: result.body,
      };
    },
    { connection }
  );

  await worker.waitUntilReady();
};
