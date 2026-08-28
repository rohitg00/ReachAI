import { worker, SUBSCRIPTIONS, PAID_ATTEMPTS } from './worker.js'
import './routes.js'
import './free.js'
import './paid.js'

worker.registerFunction(
  'reachai-backend::flow-complete',
  async (data) => {
    console.log('Flow completed', { jobId: data.jobId, PaidJobId: data.PaidJobId, emailId: data.emailId })
    return { ok: true }
  },
  { description: 'Terminal no-op for flow completion events.' },
)

console.log('[reachai-backend] registered: routes, free flow, paid flow')

for (const [function_id, topics] of Object.entries(SUBSCRIPTIONS)) {
  for (const queue of topics) {
    worker.registerTrigger({
      type: 'durable:subscriber',
      function_id,
      config: { queue, max_retries: PAID_ATTEMPTS, backoff_ms: 1000 },
    })
  }
}

process.on('SIGTERM', async () => {
  await worker.shutdown()
  process.exit(0)
})
