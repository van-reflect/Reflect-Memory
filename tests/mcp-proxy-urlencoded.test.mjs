#!/usr/bin/env node
/**
 * Ensures POST /token through the Fastify→MCP proxy works with
 * application/x-www-form-urlencoded (OAuth token exchange).
 * Run: node tests/mcp-proxy-urlencoded.test.mjs
 */

import { strict as assert } from "node:assert";
import express from "express";
import Fastify from "fastify";
import formbody from "@fastify/formbody";
import proxy from "@fastify/http-proxy";

const stubApp = express();
stubApp.use(express.urlencoded({ extended: false }));
stubApp.post("/token", (req, res) => {
  res.json({
    echo_grant: req.body?.grant_type ?? null,
    echo_code: req.body?.code ?? null,
  });
});

async function main() {
  const stubServer = await new Promise((resolve, reject) => {
    const s = stubApp.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve(s)));
  });
  const stubPort = stubServer.address().port;

  const app = Fastify({ logger: false });
  await app.register(formbody);

  await app.register(async (scope) => {
    scope.removeContentTypeParser("application/x-www-form-urlencoded");
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      async (_req, body) => body,
    );
    await scope.register(proxy, {
      upstream: `http://127.0.0.1:${stubPort}`,
      prefix: "/token",
      rewritePrefix: "/token",
    });
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=authorization_code&code=testcode&code_verifier=verifier",
  });

  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const json = await res.json();
  assert.equal(json.echo_grant, "authorization_code");
  assert.equal(json.echo_code, "testcode");

  await app.close();
  await new Promise((resolve) => stubServer.close(resolve));
  console.log("PASS mcp-proxy-urlencoded: form POST proxied correctly");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
