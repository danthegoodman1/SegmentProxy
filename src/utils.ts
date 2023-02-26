export class RetryableFetchTimeout extends Error {
  cause?: Error
  constructor (opts?: { cause?: any }) {
    super("Retryable fetch timed out after back-off")
    this.cause = opts?.cause
  }
}

/**
 * Will retry fetch on non-4XX errors until a specified number of exponential back-off steps,
 * each increasing the back-off by some number of milliseconds.
 */
export async function RetryableFetch(input: RequestInfo, init?: RequestInit<RequestInitCfProperties> | undefined, backoffConfig: { steps: number, stepMS: number } = {stepMS: 50, steps: 10}): Promise<Response> {
  try {
    let res: Response

    for (let i = 0; i < backoffConfig.steps; i++) {
      if (i > 0) {
        console.log(`sleeping ${i*backoffConfig.stepMS}ms then retrying request`)
        // Save some cycle avoiding this the first time even though it's 0
        await new Promise((resolve) => setTimeout(resolve, i*backoffConfig.stepMS))
      }

      try {
        res = await fetch(input, init)
        if (res.status < 500) {
          return res
        }
      } catch (error) {
        console.error("Error fetching:", error)
        if (i === backoffConfig.steps-1) {
          // Last one, throw the error
          throw new RetryableFetchTimeout({ cause: error })
        }
      }
    }

    return res!
  } catch (error) {
    console.error("error handling retryable fetch", error)
    throw error
  }
}
