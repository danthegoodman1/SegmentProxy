# Cloudflare Worker Segment Proxy

Used in production at [Tangia](https://www.tangia.co).

Segment allows you to proxy request completely through your own domain as seen here: https://segment.com/docs/connections/sources/catalog/libraries/website/javascript/custom-proxy

Besides only showing how to do this with Cloudfront, they have the major hurdle of https://segment.com/docs/connections/sources/catalog/libraries/website/javascript/custom-proxy/#set-up

> Follow the directions listed for CloudFront or use your own CDN setup. Once you complete those steps and verify that your proxy works for both cdn.segment.com and api.segment.io, contact Segment Product Support with the following template email...

No thanks, I can do it myself :)

This Cloudflare worker proxies CDN and API requests so that you can achieve this proxying without waiting for Segment to do their internal settings.

It also preserves the IP address of the segment client!

## Setup

Configure the env vars

`CDN_SUBDOMAIN` to the subdomain that will proxy to the segment cdn. Ex: `segcdn`

`API_SUBDOMAIN` to the subdomain that will proxy to the segment api. Ex: `segapi`

**NOTE:** In this repo we also have code that will async log to Google Cloud Logging using the API directly with https://github.com/danthegoodman1/WorkersLogger. You can fork and change that code to log somewhere else.

## How it works

First analytics.js fetches the settings from the segment CDN. Because you can only specify the CDN url in the configuration, that means the API url must come from these settings.

Looking into the tests, we can see an example of what that looks like: https://github.com/segmentio/analytics-next/blob/master/packages/browser-integration-tests/src/fixtures/settings.ts#L16

The worker intercepts the response body from the CDN, and adds in the `apiHost` property to the `Segment.io` integration. This seems to be the only time the segment CDN is used.

This tricks analytics.js to thinking that it has been configured from the server to use another api, and all subsequent api requests will then point to your worker, which proxies them to segment.
