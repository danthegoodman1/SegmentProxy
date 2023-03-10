import WorkerLogger from "cfworkerslogger"
import {Base64} from "js-base64"
import { SegmentCDNSettings } from "./types/segment"
import { ServiceAccount } from "./types/serviceAccount"
import { RetryableFetch } from "./utils"

export interface Env {
  SERVICE_ACCT: string
  CDN_SUBDOMAIN: string
  API_SUBDOMAIN: string
  PREFIX_SECRET: string
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const logger = new WorkerLogger({
      level: "DEBUG",
      levelKey: "severity",
      withMeta: {
        url: request.url,
        headers: Object.fromEntries(Array.from(request.headers.entries()).map(([key, val]) => {
          if (key.toLowerCase() === "authorization") {
            val = "REDACTED"
          }
          return [key, val]
        })),
        method: request.method
      },
      destinationFunction: async function (lines) {
        const serviceAccount = JSON.parse(env.SERVICE_ACCT) as ServiceAccount

        const pemHeader = "-----BEGIN PRIVATE KEY-----"
        const pemFooter = "-----END PRIVATE KEY-----"

        const pem = serviceAccount.private_key.replace(/\n/g, "")
        if (!pem.startsWith(pemHeader) || !pem.endsWith(pemFooter)) {
          throw new Error("Invalid service account private key")
        }

        const pemContents = pem.substring(
          pemHeader.length,
          pem.length - pemFooter.length
        )

        const buffer = Base64.toUint8Array(pemContents)

        const algorithm = {
          name: "RSASSA-PKCS1-v1_5",
          hash: {
            name: "SHA-256",
          },
        }

        const privateKey = await crypto.subtle.importKey(
          "pkcs8",
          buffer,
          algorithm,
          false,
          ["sign"]
        )

        const header = Base64.encodeURI(
          JSON.stringify({
            alg: "RS256",
            typ: "JWT",
            kid: serviceAccount.private_key_id,
          })
        )

        const iat = Math.floor(Date.now() / 1000)
        const exp = iat + 3600

        const payload = Base64.encodeURI(
          JSON.stringify({
            iss: serviceAccount.client_email,
            sub: serviceAccount.client_email,
            aud: "https://logging.googleapis.com/",
            exp,
            iat,
          })
        )

        const textEncoder = new TextEncoder()
        const inputArrayBuffer = textEncoder.encode(`${header}.${payload}`)

        const outputArrayBuffer = await crypto.subtle.sign(
          { name: "RSASSA-PKCS1-v1_5" },
          privateKey,
          inputArrayBuffer
        )

        const signature = Base64.fromUint8Array(
          new Uint8Array(outputArrayBuffer),
          true
        )

        const token = `${header}.${payload}.${signature}`

        const res = await RetryableFetch(
          "https://logging.googleapis.com/v2/entries:write",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              logName: `projects/${serviceAccount.project_id}/logs/segmentproxyworker`,
              resource: {
                type: "global", // https://cloud.google.com/logging/docs/api/v2/resource-list
                labels: { // can't put extra labels on global resource...
                  // resource_label_A: "this a resource label",
                },
              },
              labels: {
                worker: "segmentproxy",
              },
              entries: lines.map((line) => {
                  return {
                    severity: line.severity,
                    jsonPayload: {
                      message: line.message,
                      ...line.meta
                    }
                  }
                }),
                // dryRun: true
            }),
          }
        )
        console.log("Response from google", res.status)
      },
    })

    const reqURL = new URL(request.url)
    if (!reqURL.pathname.startsWith("/"+env.PREFIX_SECRET)) {
      logger.debug("request did not have prefix secret, ignoring", {
        pathName: reqURL.pathname
      })
      return new Response("SCRAM!", {
        status: 401
      })
    }

    let res: Response
    res = new Response("internal error", {
      status: 500
    })
    try {
      const sub = reqURL.hostname.split(".")[0]
      let newURL: URL
      newURL = new URL(request.url)
      newURL.pathname = newURL.pathname.split("/"+env.PREFIX_SECRET)[1]
      switch (sub) {
        case env.CDN_SUBDOMAIN:
          logger.debug("getting the cdn")
          newURL.hostname = "cdn.segment.com"
  				res = await fetch(newURL.toString(), request as any)
          const resBody = await res.text()
          logger.debug("got request body", {
            bodyText: resBody
          })
          const settings = JSON.parse(resBody) as SegmentCDNSettings
          settings.integrations["Segment.io"].apiHost = `segapi.cf.tangia.co/${env.PREFIX_SECRET}/v1`
          const newBody = JSON.stringify(settings)
          res = new Response(newBody, {
            headers: {
              ...res.headers,
              "content-length": newBody.length.toString(),
              "access-control-allow-origin": "*"
            }
          })
          break
        case env.API_SUBDOMAIN:
          logger.debug("getting the api")
          newURL.hostname = "api.segment.io"
  				res = await fetch(newURL.toString(), request as any)
          break

        default:
          res = new Response("subdomain not found", {
            status: 404,
          })
          break
      }
    } catch (error) {
      logger.error("error handling proxy", {
        err: Object.fromEntries(Object.getOwnPropertyNames(error).map((prop) => [prop, (error as any)[prop]]))
      })
    } finally {
      logger.logHTTP(request, res)
      ctx.waitUntil(logger.Drain())
      return res
    }

  },
}
