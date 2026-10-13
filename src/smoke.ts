// Read-only deployment check. No credentials, cookies, writes or provider calls.
const target = process.argv[2];
try {
  if (!target) throw new Error("Usage: node dist/smoke.js https://YOUR_API_ORIGIN");
  const origin = new URL(target);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || !(origin.protocol === "https:" || origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new Error("Use an HTTPS API origin, or HTTP loopback for development");
  for (const [path, expected] of [["/healthz", 200], ["/readyz", 200], ["/api/auth/policy", 200], ["/api/notes", 401], ["/api/companion/notes", 401]] as const) {
    const response = await fetch(new URL(path, origin), { redirect: "error", signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
    await response.body?.cancel();
    if (response.status !== expected || !response.headers.get("content-type")?.includes("application/json") || !response.headers.get("cache-control")?.includes("no-store")) throw new Error(path + " did not return the expected uncached status " + expected);
    console.log(path + " " + response.status);
  }
  console.log("Readiness and anonymous-access boundaries passed. Authenticated flows and external providers require separate checks.");
} catch (error) { console.error(error instanceof Error ? error.message : "Read-only smoke check failed"); process.exitCode = 1; }
export {};
