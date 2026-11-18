const test = require("node:test");
const assert = require("node:assert/strict");
const { SmsClient } = require("@azure/communication-sms");
const { createHttpHeaders } = require("@azure/core-rest-pipeline");

test("SMS SDK sends a v4 repeatability identifier with the patched UUID dependency", async () => {
  let payload;
  const client = new SmsClient("endpoint=https://sms.example.test;accesskey=" + Buffer.from("synthetic").toString("base64"), {
    retryOptions: { maxRetries: 0 },
    httpClient: {
      async sendRequest(request) {
        payload = JSON.parse(request.body);
        return {
          request, status: 202, headers: createHttpHeaders({ "content-type": "application/json" }),
          bodyAsText: JSON.stringify({ value: [{ to: "+15125550100", messageId: "synthetic-message", successful: true, httpStatusCode: 202 }] })
        };
      }
    }
  });
  const result = await client.send({ from: "+15125550101", to: ["+15125550100"], message: "Synthetic SDK regression" });
  assert.match(payload.smsRecipients[0].repeatabilityRequestId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(result[0].successful, true);
});
