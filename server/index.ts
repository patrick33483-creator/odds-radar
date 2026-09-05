import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import {
  registerRoutes,
  runResearchLowerCycleOnce,
  startBackgroundCollectors,
  startResearchLowerMilestoneCollector,
  startResearchMilestoneCollector,
} from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fork, type ChildProcess } from "node:child_process";
import { apiLogBody } from "./lib/api-log";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

const accessUser = process.env.RADAR_ACCESS_USER?.trim();
const accessPassword = process.env.RADAR_ACCESS_PASSWORD;
if (accessUser && accessPassword) {
  app.use((req, res, next) => {
    const authorization = req.headers.authorization ?? "";
    const encoded = authorization.startsWith("Basic ") ? authorization.slice(6) : "";
    let suppliedUser = "";
    let suppliedPassword = "";
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      suppliedUser = separator >= 0 ? decoded.slice(0, separator) : "";
      suppliedPassword = separator >= 0 ? decoded.slice(separator + 1) : "";
    } catch {
      // Invalid credentials are handled by the common rejection below.
    }
    const same = (a: string, b: string) => {
      const left = Buffer.from(a);
      const right = Buffer.from(b);
      return left.length === right.length && timingSafeEqual(left, right);
    };
    if (same(suppliedUser, accessUser) && same(suppliedPassword, accessPassword)) {
      return next();
    }
    res.setHeader("WWW-Authenticate", 'Basic realm="Odds Radar", charset="UTF-8"');
    return res.status(401).send("Authentication required");
  });
}

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(apiLogBody(path, capturedJsonResponse))}`;
      }

      log(logLine);
    }
  });

  next();
});

const processRole = !isMainThread
  ? workerData?.role
  : process.env.RADAR_WORKER_ROLE;

if (
  processRole === "collector"
  || processRole === "milestone"
  || processRole === "milestone-lower"
  || processRole === "milestone-lower-once"
) {
  if (processRole === "milestone") {
    let lowerCycle: ChildProcess | null = null;
    const expectedStops = new WeakSet<ChildProcess>();
    const checkpointReported = new WeakSet<ChildProcess>();
    let lowerCycleSequence = 0;
    const stopLowerCycle = async () => {
      const active = lowerCycle;
      lowerCycle = null;
      if (active) {
        expectedStops.add(active);
        // A separate OS process can be stopped even while it is executing a
        // synchronous native SQLite call. Core never starts until SIGKILL has
        // been observed; failure to stop is fatal so exclusivity is preserved.
        const stopped = new Promise<boolean>((resolve) => {
          active.once("exit", () => resolve(true));
          setTimeout(() => resolve(false), 1_000).unref();
        });
        active.kill("SIGKILL");
        if (!await stopped) {
          console.error("Lower research cycle did not stop before core deadline");
          process.exit(1);
        }
      }
    };
    const startLowerCycle = () => {
      let worker: ChildProcess;
      try {
        worker = fork(process.argv[1], [], {
          env: {
            ...process.env,
            RADAR_WORKER_ROLE: "milestone-lower-once",
            RADAR_LOWER_DISPATCH_OFFSET: String(lowerCycleSequence++),
          },
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        });
      } catch (err) {
        console.error("Unable to launch lower research cycle:", err);
        process.exit(1);
      }
      lowerCycle = worker;
      worker.on("message", (outcome) => {
        if (
          outcome
          && typeof outcome === "object"
          && "event" in outcome
          && outcome.event === "research_milestone_lower_tier"
        ) {
          checkpointReported.add(worker);
        }
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          scope: "radar",
          event: "research_lower_cycle",
          outcome,
        }));
      });
      worker.on("error", (err) => {
        console.error("Lower research cycle worker error:", err);
        if (!expectedStops.has(worker) && !checkpointReported.has(worker)) {
          process.exit(1);
        }
      });
      worker.on("exit", (code, signal) => {
        if (lowerCycle === worker) lowerCycle = null;
        if (code !== 0 && !expectedStops.has(worker)) {
          console.error(`Lower research cycle worker exited with code ${code}, signal ${signal}`);
          if (!checkpointReported.has(worker)) process.exit(1);
        }
      });
    };
    startResearchMilestoneCollector({
      beforeRun: stopLowerCycle,
      afterRun: startLowerCycle,
    });
    log("research milestone collector started in isolated worker", "milestone");
  } else if (processRole === "milestone-lower-once") {
    const sendToOwner = (message: unknown) => new Promise<void>((resolve, reject) => {
      if (parentPort) {
        parentPort.postMessage(message);
        resolve();
        return;
      }
      if (!process.send) {
        reject(new Error("Lower research cycle has no IPC channel"));
        return;
      }
      process.send(message, undefined, undefined, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    void runResearchLowerCycleOnce(
      Number.isFinite(Number(process.env.RADAR_LOWER_DISPATCH_OFFSET))
        ? Number(process.env.RADAR_LOWER_DISPATCH_OFFSET)
        : undefined,
      async (milestone) => {
        await sendToOwner({
          ts: new Date().toISOString(),
          scope: "radar",
          event: "research_milestone_lower_tier",
          ...milestone,
        });
      },
    )
      .then(async (outcome) => {
        await sendToOwner(outcome);
        process.exit(0);
      })
      .catch((err) => {
        console.error("Lower research cycle failed:", err);
        process.exit(1);
      });
  } else if (processRole === "milestone-lower") {
    startResearchLowerMilestoneCollector();
    log("lower research milestone collector started in isolated worker", "milestone-lower");
  } else {
    startBackgroundCollectors();
    log("background collectors started in isolated worker", "collector");
  }
  // Collector timers deliberately use unref() so tests/process shutdown are
  // clean. This one reference owns the production worker lifecycle.
  setInterval(() => undefined, 60_000);
} else void (async () => {
  if (process.env.NODE_ENV !== "production") {
    startBackgroundCollectors();
    startResearchMilestoneCollector();
    startResearchLowerMilestoneCollector();
  }
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  const host = process.env.HOST || "0.0.0.0";
  httpServer.listen(
    {
      port,
      host,
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
      if (process.env.NODE_ENV === "production") {
        const collector = new Worker(process.argv[1], {
          workerData: { role: "collector" },
        });
        const milestone = new Worker(process.argv[1], {
          workerData: { role: "milestone" },
        });
        collector.on("error", (err) => {
          console.error("Background collector worker error:", err);
        });
        collector.on("exit", (code) => {
          if (code !== 0) {
            console.error(`Background collector worker exited with code ${code}`);
          }
        });
        milestone.on("error", (err) => {
          console.error("Research milestone worker error:", err);
        });
        milestone.on("exit", (code) => {
          if (code !== 0) {
            console.error(`Research milestone worker exited with code ${code}`);
            // Keep container health honest: Docker restarts the whole process
            // instead of leaving HTTP green with checkpoint collection dead.
            process.exit(1);
          }
        });
      }
    },
  );
})();
