/**
 * Fake fleet of applications for the demo: every path answers like a healthy
 * service (http://simulator:8080/<project>/<env>/<app>/health), so 100+
 * monitors can run locally without probing anyone else's servers.
 *
 * Failures are injected on a path prefix through /_chaos (see chaos.ts):
 * "acme-store/production" takes a whole environment down, like a VPS reboot.
 *   down   the connection is reset
 *   error  HTTP 500
 *   slow   answers after 60 s (past the monitor timeout)
 */

import { createServer, type IncomingMessage } from "node:http";

type Mode = "down" | "error" | "slow";
const MODES: Mode[] = ["down", "error", "slow"];
const faults = new Map<string, Mode>();

const PORT = Number(process.env.PORT ?? 8080);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readJson(req: IncomingMessage): Promise<Record<string, string>> {
    let body = "";
    for await (const chunk of req) body += chunk;
    return body ? JSON.parse(body) : {};
}

/** The longest injected prefix that matches the path wins. */
function faultFor(path: string): Mode | undefined {
    let match: string | undefined;
    for (const prefix of faults.keys()) {
        if ((path === prefix || path.startsWith(`${prefix}/`)) && prefix.length > (match?.length ?? -1)) match = prefix;
    }
    return match ? faults.get(match) : undefined;
}

createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0].replace(/^\/+|\/+$/g, "");
    const json = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
    };

    if (path === "_chaos") {
        if (req.method === "POST") {
            const { target, mode } = await readJson(req);
            const prefix = (target ?? "").replace(/^\/+|\/+$/g, "");
            if (!prefix || !MODES.includes(mode as Mode)) return json(400, { error: `target and mode (${MODES.join("|")}) required` });
            faults.set(prefix, mode as Mode);
            console.log(`chaos: ${prefix} -> ${mode}`);
        } else if (req.method === "DELETE") {
            const { target } = await readJson(req);
            if (target) faults.delete(target.replace(/^\/+|\/+$/g, ""));
            else faults.clear();
            console.log(`chaos: cleared ${target ?? "all"}`);
        }
        return json(200, Object.fromEntries(faults));
    }

    switch (faultFor(path)) {
        case "down":
            return req.socket.destroy();
        case "error":
            return json(500, { status: "error", service: path });
        case "slow":
            await sleep(60_000);
    }

    // A little jitter so response-time charts look like real traffic.
    await sleep(5 + Math.random() * 120);
    json(200, { status: "ok", service: path });
}).listen(PORT, () => console.log(`simulator listening on :${PORT}`));
