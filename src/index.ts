import WorkerLogger from "cfworkerslogger"

export interface Env {}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext
	): Promise<Response> {
		const logger = new WorkerLogger({
			level: "DEBUG",
			levelKey: "severity",
			destinationFunction: async function(lines) {
				console.log("I am sending lines", JSON.stringify(lines))
			}
		})
		logger.debug("this is debug")
		logger.warn("this is a warn")
		const res = new Response("Hello World!");
		ctx.waitUntil(logger.Drain())
		return res
	},
};
