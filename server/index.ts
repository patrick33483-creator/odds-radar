import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
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

(async () => {
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
    },
  );
})();
