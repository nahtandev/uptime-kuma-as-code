/**
 * Minimal client for the Socket.IO API that Uptime Kuma's own web UI uses.
 *
 * Uptime Kuma has no REST API for configuration: API keys only unlock /metrics.
 * Everything else (monitors, notifications) goes through these socket events,
 * authenticated with a real user login.
 */

import { io, type Socket } from "socket.io-client";

const TIMEOUT_MS = 15_000;

export type Ack = { ok: boolean; msg?: string; [key: string]: unknown };

/** A monitor as Kuma sends it in `monitorList` (only the fields we read). */
export type KumaMonitor = {
    id: number;
    name: string;
    type: string;
    active: boolean;
    parent: number | null;
    [key: string]: unknown;
};

export type KumaNotification = { id: number; name: string; config?: string };

export type Heartbeat = { monitorID: number; status: number; msg: string; ping: number | null };

export type KumaSession = {
    socket: Socket;
    monitors: () => Record<string, KumaMonitor>;
    notifications: () => KumaNotification[];
    heartbeats: Map<number, Heartbeat>;
    version: () => string | undefined;
    listsReceived: () => boolean;
    emit: (event: string, ...args: unknown[]) => Promise<Ack>;
    close: () => void;
};

export type Credentials = { url: string; username: string; password: string; totp?: string };

function once<T>(socket: Socket, event: string, ms = TIMEOUT_MS): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no "${event}" after ${ms} ms`)), ms).unref();
        socket.once(event, (payload: T) => {
            clearTimeout(timer);
            resolve(payload);
        });
    });
}

export async function until(predicate: () => boolean, ms: number, step = 100): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(step);
    }
    return false;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opens the socket without logging in (enough for `needSetup` and `setup`). */
export async function connect(url: string): Promise<KumaSession> {
    const socket = io(url, { transports: ["websocket"], reconnection: false, timeout: TIMEOUT_MS });

    // The server pushes these on its own right after login: listen before.
    let monitors: Record<string, KumaMonitor> | undefined;
    let notifications: KumaNotification[] | undefined;
    let version: string | undefined;
    const heartbeats = new Map<number, Heartbeat>();

    socket.on("monitorList", (list: Record<string, KumaMonitor>) => (monitors = list));
    socket.on("updateMonitorIntoList", (list: Record<string, KumaMonitor>) => {
        monitors = { ...monitors, ...list };
    });
    socket.on("deleteMonitorFromList", (id: number) => {
        if (monitors) delete monitors[String(id)];
    });
    socket.on("notificationList", (list: KumaNotification[]) => (notifications = list));
    socket.on("info", (info: { version?: string }) => (version = info.version ?? version));
    socket.on("heartbeatList", (id: number, list: Heartbeat[]) => {
        const last = list?.at(-1);
        if (last) heartbeats.set(Number(id), last);
    });
    socket.on("heartbeat", (beat: Heartbeat) => heartbeats.set(Number(beat.monitorID), beat));

    // Wait for `info`, not just `connect`: the server registers its event
    // handlers only after sending `info`, and silently drops anything that
    // arrives before. An early `login` would just never get an answer.
    await Promise.race([
        once(socket, "info"),
        once<Error>(socket, "connect_error").then((err) => {
            throw new Error(`cannot connect to ${url} (${err?.message ?? err})`);
        }),
    ]);

    const emit = (event: string, ...args: unknown[]) =>
        new Promise<Ack>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`no ack for "${event}"`)), TIMEOUT_MS).unref();
            socket.emit(event, ...args, (res: Ack) => {
                clearTimeout(timer);
                resolve(res);
            });
        });

    return {
        socket,
        monitors: () => monitors ?? {},
        notifications: () => notifications ?? [],
        heartbeats,
        version: () => version,
        listsReceived: () => monitors !== undefined && notifications !== undefined,
        emit,
        close: () => socket.disconnect(),
    };
}

/**
 * Connects and logs in, then waits for the monitor and notification lists.
 * One login per run: Kuma rate-limits logins (20 per minute).
 */
export async function login(creds: Credentials): Promise<KumaSession> {
    const session = await connect(creds.url);
    let ready = false;
    try {
        const res = await session.emit("login", {
            username: creds.username,
            password: creds.password,
            token: creds.totp ?? "",
        });
        if (!res.ok) {
            throw new Error(
                res.tokenRequired
                    ? "2FA is enabled on this account: set UPTIME_KUMA_TOTP"
                    : `login refused (${res.msg})`,
            );
        }
        // Both lists arrive in a burst after a successful login.
        if (!(await until(session.listsReceived, 10_000))) {
            throw new Error("monitor and notification lists not received after login");
        }
        ready = true;
        return session;
    } finally {
        if (!ready) session.close();
    }
}

export function credentialsFromEnv(): Credentials {
    const url = process.env.UPTIME_KUMA_URL?.replace(/\/+$/, "");
    const username = process.env.UPTIME_KUMA_USERNAME;
    const password = process.env.UPTIME_KUMA_PASSWORD;
    const missing = [
        ["UPTIME_KUMA_URL", url],
        ["UPTIME_KUMA_USERNAME", username],
        ["UPTIME_KUMA_PASSWORD", password],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw new Error(`missing in .env: ${missing.join(", ")}`);
    return { url: url!, username: username!, password: password!, totp: process.env.UPTIME_KUMA_TOTP };
}
