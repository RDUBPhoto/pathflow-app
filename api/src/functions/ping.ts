import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

export async function ping(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return {
    status: 200,
    jsonBody: { ok: true, message: "pong" }
  };
}

app.http("ping", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "ping",
  handler: ping
});