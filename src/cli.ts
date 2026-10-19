#!/usr/bin/env node
/**
 * uptime-kuma-as-code
 *
 *   setup        create the admin account on a fresh instance (from .env)
 *   healthcheck  check the connection and the credentials
 *   plan         show what `apply` would change, write nothing
 *   apply        create or update notifications, groups and monitors
 *   apply --prune  also delete monitors that are no longer in the file
 *   status       list monitors by their last heartbeat (UP, DOWN, PENDING)
 *
 * The monitors file defaults to monitors.json, override with MONITORS_FILE.
 */

import { existsSync } from "node:fs";
import { apply } from "./apply.ts";
import { loadConfig } from "./config.ts";
import { connect, credentialsFromEnv, login, sleep, type KumaSession } from "./kuma.ts";

const STATUS: Record<number, string> = { 0: "DOWN", 1: "UP", 2: "PENDING", 3: "MAINTENANCE" };

function monitorsFile(): string {
    const file = process.env.MONITORS_FILE ?? "monitors.json";
    if (!existsSync(file)) throw new Error(`${file} not found (copy monitors.example.json, or set MONITORS_FILE)`);
    return file;
}

async function withSession(run: (kuma: KumaSession) => Promise<void>) {
    const kuma = await login(credentialsFromEnv());
    try {
        await run(kuma);
    } finally {
        kuma.close();
    }
}

async function setup() {
    const { url, username, password } = credentialsFromEnv();
    const kuma = await connect(url);
    try {
        const needed = await new Promise<boolean>((resolve) => kuma.socket.emit("needSetup", resolve));
        if (!needed) return console.log("✓ Admin account already exists, nothing to do.");
        const res = await kuma.emit("setup", username, password);
        if (!res.ok) throw new Error(`setup refused (${res.msg})`);
        console.log(`✓ Admin account "${username}" created.`);
    } finally {
        kuma.close();
    }
}

async function healthcheck(kuma: KumaSession) {
    const monitors = Object.values(kuma.monitors());
    console.log(`✓ Logged in       ${process.env.UPTIME_KUMA_URL}`);
    console.log(`✓ Version         ${kuma.version() ?? "unknown"}`);
    console.log(`✓ Monitors        ${monitors.length} (${monitors.filter((m) => m.active).length} active)`);
    console.log(`✓ Notifications   ${kuma.notifications().map((n) => n.name).join(", ") || "none"}`);
}

async function status(kuma: KumaSession) {
    // Heartbeat lists arrive in a burst after login, one event per monitor.
    await sleep(Number(process.env.STATUS_SETTLE_MS ?? 5000));
    const rows = Object.values(kuma.monitors())
        .filter((m) => m.type !== "group")
        .map((m) => {
            const beat = kuma.heartbeats.get(m.id);
            return { name: m.name, status: beat ? STATUS[beat.status] ?? String(beat.status) : "NO DATA", msg: beat?.msg ?? "" };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

    const count = (s: string) => rows.filter((r) => r.status === s).length;
    for (const s of ["DOWN", "PENDING", "NO DATA"]) {
        const list = rows.filter((r) => r.status === s);
        if (!list.length) continue;
        console.log(`\n${s} (${list.length})`);
        for (const r of list) console.log(`   ${r.name.padEnd(48)} ${r.msg}`);
    }
    console.log(`\nUP ${count("UP")} / DOWN ${count("DOWN")} / PENDING ${count("PENDING")} / no data ${count("NO DATA")}   (${rows.length} monitors)`);
}

const [command, ...flags] = process.argv.slice(2);

try {
    switch (command) {
        case "setup":
            await setup();
            break;
        case "healthcheck":
            await withSession(healthcheck);
            break;
        case "plan":
        case "apply": {
            const config = loadConfig(monitorsFile());
            await withSession((kuma) => apply(kuma, config, { apply: command === "apply", prune: flags.includes("--prune") }));
            break;
        }
        case "status":
            await withSession(status);
            break;
        default:
            console.error("usage: cli.ts <setup|healthcheck|plan|apply [--prune]|status>");
            process.exitCode = 2;
    }
} catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exitCode = 1;
}
