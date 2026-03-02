import express, { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ============================================================
// Zotero API Helper
// ============================================================
const ZOTERO_API_BASE = "https://api.zotero.org";

interface ZoteroConfig {
  apiKey: string;
  libraryId: string;
  libraryType: "users" | "groups";
}

function getConfig(): ZoteroConfig {
  const apiKey = process.env.ZOTERO_API_KEY;
  const libraryId = process.env.ZOTERO_LIBRARY_ID;
  const libraryType =
    (process.env.ZOTERO_LIBRARY_TYPE as "users" | "groups") || "users";

  if (!apiKey || !libraryId) {
    throw new Error(
      "ZOTERO_API_KEY and ZOTERO_LIBRARY_ID environment variables are required."
    );
  }
  return { apiKey, libraryId, libraryType };
}

async function zoteroFetch(path: string, params?: Record<string, string>) {
  const config = getConfig();
  const base = `${ZOTERO_API_BASE}/${config.libraryType}/${config.libraryId}`;
  const url = new URL(`${base}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      "Zotero-API-Key": config.apiKey,
      "Zotero-API-Version": "3",
    },
  });

  if (!res.ok) {
    throw new Error(`Zotero API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ============================================================
// Format helpers
// ============================================================
function formatItem(item: any): string {
  const d = item.data || item;
  const parts: string[] = [];

  parts.push(`[${d.itemType || "unknown"}] ${d.title || "(no title)"}`);

  if (d.creators?.length) {
    const authors = d.creators
      .map((c: any) =>
        c.name ? c.name : `${c.lastName || ""}, ${c.firstName || ""}`
      )
      .join("; ");
    parts.push(`Authors: ${authors}`);
  }
  if (d.date) parts.push(`Date: ${d.date}`);
  if (d.publicationTitle) parts.push(`Journal: ${d.publicationTitle}`);
  if (d.DOI) parts.push(`DOI: ${d.DOI}`);
  if (d.url) parts.push(`URL: ${d.url}`);
  if (d.volume) parts.push(`Volume: ${d.volume}`);
  if (d.issue) parts.push(`Issue: ${d.issue}`);
  if (d.pages) parts.push(`Pages: ${d.pages}`);
  if (d.abstractNote) parts.push(`Abstract: ${d.abstractNote}`);
  if (d.tags?.length) {
    parts.push(`Tags: ${d.tags.map((t: any) => t.tag).join(", ")}`);
  }
  if (item.key) parts.push(`Key: ${item.key}`);

  return parts.join("\n");
}

function formatCollection(col: any): string {
  const d = col.data || col;
  return `[Collection] ${d.name} (key: ${col.key}, items: ${d.numItems || 0})`;
}

// ============================================================
// Create MCP Server with Zotero tools
// ============================================================
function createServer(): McpServer {
  const server = new McpServer({
    name: "zotero-mcp",
    version: "1.0.0",
  });

  // --- Tool: search_library ---
  server.tool(
    "search_library",
    "Search your Zotero library by keyword. Returns matching items with metadata.",
    {
      query: z.string().describe("Search keyword (title, author, tag, etc.)"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max results to return (default 20)"),
    },
    async ({ query, limit }) => {
      const items = await zoteroFetch("/items", {
        q: query,
        limit: String(limit),
        sort: "date",
        direction: "desc",
      });

      if (!items?.length) {
        return { content: [{ type: "text", text: "No results found." }] };
      }

      const text = items
        .filter((i: any) => i.data?.itemType !== "attachment")
        .map((i: any, idx: number) => `--- ${idx + 1} ---\n${formatItem(i)}`)
        .join("\n\n");

      return { content: [{ type: "text", text: text || "No results found." }] };
    }
  );

  // --- Tool: get_collections ---
  server.tool(
    "get_collections",
    "List all collections (folders) in your Zotero library.",
    {},
    async () => {
      const collections = await zoteroFetch("/collections", { limit: "100" });

      if (!collections?.length) {
        return { content: [{ type: "text", text: "No collections found." }] };
      }

      const text = collections.map((c: any) => formatCollection(c)).join("\n");
      return { content: [{ type: "text", text }] };
    }
  );

  // --- Tool: get_collection_items ---
  server.tool(
    "get_collection_items",
    "Get all items in a specific Zotero collection by collection key.",
    {
      collection_key: z.string().describe("The collection key"),
      limit: z.number().min(1).max(100).default(25).describe("Max results"),
    },
    async ({ collection_key, limit }) => {
      const items = await zoteroFetch(
        `/collections/${collection_key}/items`,
        {
          limit: String(limit),
          sort: "date",
          direction: "desc",
        }
      );

      if (!items?.length) {
        return {
          content: [
            { type: "text", text: "No items found in this collection." },
          ],
        };
      }

      const text = items
        .filter((i: any) => i.data?.itemType !== "attachment")
        .map((i: any, idx: number) => `--- ${idx + 1} ---\n${formatItem(i)}`)
        .join("\n\n");

      return { content: [{ type: "text", text: text || "No items found." }] };
    }
  );

  // --- Tool: get_item_details ---
  server.tool(
    "get_item_details",
    "Get full details for a specific Zotero item by its key.",
    {
      item_key: z.string().describe("The item key (e.g., 'ABCD1234')"),
    },
    async ({ item_key }) => {
      const item = await zoteroFetch(`/items/${item_key}`);
      return { content: [{ type: "text", text: formatItem(item) }] };
    }
  );

  // --- Tool: get_recent_items ---
  server.tool(
    "get_recent_items",
    "Get recently added items in your Zotero library.",
    {
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of recent items to return"),
    },
    async ({ limit }) => {
      const items = await zoteroFetch("/items", {
        limit: String(limit),
        sort: "dateAdded",
        direction: "desc",
      });

      if (!items?.length) {
        return { content: [{ type: "text", text: "No items found." }] };
      }

      const text = items
        .filter((i: any) => i.data?.itemType !== "attachment")
        .map((i: any, idx: number) => `--- ${idx + 1} ---\n${formatItem(i)}`)
        .join("\n\n");

      return { content: [{ type: "text", text: text || "No items found." }] };
    }
  );

  // --- Tool: search_by_tag ---
  server.tool(
    "search_by_tag",
    "Find items with a specific tag in your Zotero library.",
    {
      tag: z.string().describe("The tag to search for"),
      limit: z.number().min(1).max(100).default(25).describe("Max results"),
    },
    async ({ tag, limit }) => {
      const items = await zoteroFetch("/items", {
        tag: tag,
        limit: String(limit),
        sort: "date",
        direction: "desc",
      });

      if (!items?.length) {
        return {
          content: [
            { type: "text", text: `No items found with tag "${tag}".` },
          ],
        };
      }

      const text = items
        .filter((i: any) => i.data?.itemType !== "attachment")
        .map((i: any, idx: number) => `--- ${idx + 1} ---\n${formatItem(i)}`)
        .join("\n\n");

      return { content: [{ type: "text", text: text || "No items found." }] };
    }
  );

  // --- Tool: get_all_tags ---
  server.tool(
    "get_all_tags",
    "List all tags used in your Zotero library.",
    {},
    async () => {
      const tags = await zoteroFetch("/tags", { limit: "100" });

      if (!tags?.length) {
        return { content: [{ type: "text", text: "No tags found." }] };
      }

      const text = tags
        .map((t: any) => `${t.tag} (${t.meta?.numItems || 0} items)`)
        .join("\n");

      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}

// ============================================================
// Express app with Streamable HTTP transport
// ============================================================
const app = express();
app.use(express.json());

// Session management
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    // Existing session
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // New session — check if it's an initialize request
  if (!sessionId) {
    const newSessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
    });

    transports.set(newSessionId, transport);

    // Clean up on close
    transport.onclose = () => {
      transports.delete(newSessionId);
    };

    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // Session not found
  res.status(400).json({ error: "Invalid session" });
});

// GET for SSE stream (server-to-client notifications)
app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing session" });
    return;
  }

  const transport = transports.get(sessionId)!;
  await transport.handleRequest(req, res);
});

// DELETE to terminate session
app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    transports.delete(sessionId);
    return;
  }

  res.status(400).json({ error: "Invalid or missing session" });
});

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", server: "zotero-mcp", version: "1.0.0" });
});

// Start server
const PORT = parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, () => {
  console.log(`Zotero MCP Server running on port ${PORT}`);
  console.log(`Endpoint: http://localhost:${PORT}/mcp`);
});
