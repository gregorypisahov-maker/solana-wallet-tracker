import http from "node:http";

const serviceName = process.argv[2] || "legacy-service";
const port = Number(process.env.PORT || 3000);
const startedAt = new Date().toISOString();

const payload = () => JSON.stringify({
  ok: true,
  enabled: false,
  retired: true,
  service: serviceName,
  replacement: "single-market-bot",
  startedAt,
});

const server = http.createServer((_req, res) => {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload());
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[retired-service] ${serviceName} disabled; replacement=single-market-bot port=${port}`);
});

function shutdown(signal) {
  console.log(`[retired-service] ${serviceName} received ${signal}; shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
