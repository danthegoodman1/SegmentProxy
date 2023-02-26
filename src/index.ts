import WorkerLogger from "cfworkerslogger"
import Base64 from "js-base64"
import { SegmentCDNSettings } from "./types/segment"
import { ServiceAccount } from "./types/serviceAccount"
import { RetryableFetch } from "./utils"

export interface Env {
  SERVICE_ACCT: string
  CDN_SUBDOMAIN: string
  API_SUBDOMAIN: string
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
              logName: `projects/${serviceAccount.project_id}/logs/cloudflareloggingtest`,
              resource: {
                type: "global", // https://cloud.google.com/logging/docs/api/v2/resource-list
                labels: {
                  resource_label_A: "this a resource label",
                },
              },
              labels: {
                label_A: "a content",
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
                dryRun: true
            }),
          }
        )
        console.log("Response from google", res.status)
      },
    })

    let res: Response | Promise<Response>
    const sub = new URL(request.url).hostname.split(".")[0]
    let newURL: URL
    switch (sub) {
      case env.CDN_SUBDOMAIN:
        newURL = new URL(request.url)
        newURL.hostname = "cdn.segment.com"
				res = await fetch(newURL.toString(), request as any)
        const resBody = await res.json() as SegmentCDNSettings
        resBody.integrations["Segment.io"].apiHost = "api.segment.io/v1"
        const newBody = JSON.stringify(resBody)
        res = new Response(newBody, {
          headers: {
            ...res.headers,
            "content-length": newBody.length.toString()
          }
        })
        break
      case env.API_SUBDOMAIN:
				newURL = new URL(request.url)
        newURL.hostname = "api.segment.io"
				res = fetch(newURL.toString(), request as any)
        break

      default:
        res = new Response("subdomain not found", {
          status: 404,
        })
        break
    }

    ctx.waitUntil(logger.Drain())
    return res
  },
}
