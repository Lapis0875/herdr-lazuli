// The HTML viewer's loopback file server (DESIGN B7, ARCHITECTURE §5, CONTRACTS "Node module:
// bin/lib/static-server.mjs"): GET and HEAD of files under one root on 127.0.0.1, so module scripts
// and fetch() work. Disk content only, never cached; no directory listing; `Host` must be exactly
// 127.0.0.1:<port>. `/__lazuli/md/<rel>` serves a Markdown file as a rendered page.

import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
const MD_PREFIX = "/__lazuli/md/";
const MD_EXT = /\.(md|markdown)$/i;

/** Starts the server; see CONTRACTS for every request rule. */
export async function startStaticServer({ root, host = "127.0.0.1", port = 0, renderMarkdown } = {}) {
  if (host !== "127.0.0.1") throw new Error("static-server: host must be 127.0.0.1");
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("static-server: root must be an absolute path");
  const realRoot = await realpath(root);
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  let render = typeof renderMarkdown === "function" ? renderMarkdown : null;
  let expectedHost = "";

  async function markdownRenderer() {
    if (!render) render = (await import("./md-page.mjs")).renderPage;
    return render;
  }

  // The real path of a root-relative URL path when it is a file under the root, else null.
  async function resolveFile(urlPath) {
    const segments = [];
    for (const raw of urlPath.split("/")) {
      if (raw === "") continue;
      let seg;
      try {
        seg = decodeURIComponent(raw);
      } catch {
        return null;
      }
      if (seg.includes("/") || seg.includes("\\") || seg.includes("\0")) return null;
      segments.push(seg);
    }
    let real;
    try {
      real = await realpath(path.join(realRoot, ...segments));
    } catch {
      return null;
    }
    if (real !== realRoot && !real.startsWith(prefix)) return null;
    try {
      const st = await stat(real);
      return st.isFile() ? { real, size: st.size, name: segments.at(-1) ?? "" } : null;
    } catch {
      return null;
    }
  }

  async function handle(req, res) {
    const head = req.method === "HEAD";
    const reply = (status, headers = {}, body = null) => {
      const bytes = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
      res.writeHead(status, { "Cache-Control": "no-store", "Content-Length": bytes ? bytes.length : 0, ...headers });
      res.end(head || !bytes ? undefined : bytes);
    };
    if (req.headers.host !== expectedHost) return reply(403);
    if (req.method !== "GET" && !head) return reply(405, { Allow: "GET, HEAD" });
    const target = String(req.url ?? "");
    if (!target.startsWith("/")) return reply(404);
    const urlPath = target.split(/[?#]/, 1)[0];

    if (urlPath.startsWith(MD_PREFIX)) {
      const file = await resolveFile(urlPath.slice(MD_PREFIX.length - 1));
      if (!file || !MD_EXT.test(file.real)) return reply(404);
      let text;
      try {
        text = await readFile(file.real, "utf8");
      } catch {
        return reply(404);
      }
      let page;
      try {
        page = (await markdownRenderer())(text, { title: file.name });
      } catch (e) {
        process.stderr.write(`static-server: markdown render failed: ${e?.message ?? e}\n`);
        return reply(500);
      }
      return reply(200, { "Content-Type": "text/html; charset=utf-8" }, page);
    }

    const file = await resolveFile(urlPath);
    if (!file) return reply(404);
    const type = TYPES[path.extname(file.real).toLowerCase()] ?? "application/octet-stream";
    const headers = { "Cache-Control": "no-store", "Content-Type": type, "Content-Length": file.size };
    if (head) {
      res.writeHead(200, headers);
      res.end();
      return;
    }
    const stream = createReadStream(file.real);
    stream.once("error", () => {
      if (!res.headersSent) reply(404);
      else res.destroy();
    });
    stream.once("open", () => {
      res.writeHead(200, headers);
      stream.pipe(res);
    });
  }

  const sockets = new Set();
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      process.stderr.write(`static-server: ${e?.stack ?? e}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { "Cache-Control": "no-store", "Content-Length": 0 });
        res.end();
      } else res.destroy();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const actualPort = server.address().port;
  const origin = `http://127.0.0.1:${actualPort}`;
  expectedHost = `127.0.0.1:${actualPort}`;
  let closing = null;

  return {
    port: actualPort,
    origin,
    url(rel) {
      return `${origin}/${String(rel).split("/").filter((s) => s !== "").map(encodeURIComponent).join("/")}`;
    },
    close() {
      if (!closing) {
        closing = new Promise((resolve) => {
          server.close(() => resolve());
          for (const s of sockets) s.destroy();
        });
      }
      return closing;
    },
  };
}
