#!/usr/bin/env node
/**
 * Break and repair simulated services.
 *
 *   npm run chaos -- down  acme-store/production/checkout-web
 *   npm run chaos -- error acme-store/staging
 *   npm run chaos -- slow  ledgerly
 *   npm run chaos -- fix   acme-store/production/checkout-web
 *   npm run chaos -- reset            (repair everything)
 *   npm run chaos -- list
 */

const base = process.env.SIMULATOR_URL ?? "http://localhost:8080";
const [action, target] = process.argv.slice(2);

const request = (method: string, body?: object) =>
    fetch(`${base}/_chaos`, {
        method,
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
    });

let res: Response;
if (["down", "error", "slow"].includes(action) && target) res = await request("POST", { target, mode: action });
else if (action === "fix" && target) res = await request("DELETE", { target });
else if (action === "reset") res = await request("DELETE");
else if (action === "list") res = await request("GET");
else {
    console.error("usage: chaos <down|error|slow|fix> <project[/env[/app]]> | reset | list");
    process.exit(2);
}

if (!res.ok) {
    console.error(`✗ ${res.status} ${await res.text()}`);
    process.exit(1);
}
const faults = Object.entries((await res.json()) as Record<string, string>);
console.log(faults.length ? faults.map(([t, m]) => `${m.padEnd(6)} ${t}`).join("\n") : "All services healthy.");
