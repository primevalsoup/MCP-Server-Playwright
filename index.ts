#!/usr/bin/env node

import yargs from "yargs/yargs";
import { hideBin } from 'yargs/helpers'
import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  CallToolResult,
  TextContent,
  ImageContent,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import playwright, { Browser, Page, BrowserContext, chromium, firefox, webkit } from "playwright";

// Log entry interfaces
interface NetworkLogEntry {
  id: string;
  timestamp: number;
  type: 'request' | 'response' | 'requestfailed';
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  duration?: number;
  errorText?: string;
}

interface ConsoleLogEntry {
  timestamp: number;
  type: string;
  text: string;
}

// Buffer limits
const MAX_NETWORK_LOGS = 1000;
const MAX_CONSOLE_LOGS = 500;

enum ToolName {
  BrowserLaunch = "browser_launch",
  BrowserClose = "browser_close",
  BrowserNavigate = "browser_navigate",
  BrowserScreenshot = "browser_screenshot",
  BrowserClick = "browser_click",
  BrowserClickText = "browser_click_text",
  BrowserFill = "browser_fill",
  BrowserSelect = "browser_select",
  BrowserSelectText = "browser_select_text",
  BrowserHover = "browser_hover",
  BrowserHoverText = "browser_hover_text",
  BrowserEvaluate = "browser_evaluate",
  BrowserGetLogs = "browser_get_logs"
}

// Define the tools once to avoid repetition
const TOOLS: Tool[] = [
  {
    name: ToolName.BrowserLaunch,
    description: "Launch a new browser or connect to existing via CDP. Auto-closes any existing browser.",
    inputSchema: {
      type: "object",
      properties: {
        browserType: {
          type: "string",
          enum: ["chromium", "firefox", "webkit"],
          description: "Browser to launch (default: chromium)"
        },
        headless: {
          type: "boolean",
          description: "Run in headless mode (default: false)"
        },
        cdpEndpoint: {
          type: "string",
          description: "CDP endpoint URL for existing browser (chromium only, e.g., http://localhost:9222)"
        },
        debugPort: {
          type: "number",
          description: "Remote debugging port for launched browser (chromium only, not applicable when using cdpEndpoint)"
        },
        viewport: {
          type: "object",
          properties: {
            width: { type: "number" },
            height: { type: "number" }
          },
          description: "Viewport size"
        },
        windowPosition: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" }
          },
          description: "Window position on screen (non-headless only)"
        }
      },
      required: []
    }
  },
  {
    name: ToolName.BrowserClose,
    description: "Close the current browser instance",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: ToolName.BrowserNavigate,
    description: "Navigate to a URL",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
    },
  },
  {
    name: ToolName.BrowserScreenshot,
    description: "Take a screenshot of the current page or a specific element",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for the screenshot" },
        selector: { type: "string", description: "CSS selector for element to screenshot" },
        fullPage: { type: "boolean", description: "Take a full page screenshot (default: false)", default: false },
      },
      required: ["name"],
    },
  },
  {
    name: ToolName.BrowserClick,
    description: "Click an element on the page using CSS selector",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for element to click" },
      },
      required: ["selector"],
    },
  },
  {
    name: ToolName.BrowserClickText,
    description: "Click an element on the page by its text content",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text content of the element to click" },
      },
      required: ["text"],
    },
  },
  {
    name: ToolName.BrowserFill,
    description: "Fill out an input field",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for input field" },
        value: { type: "string", description: "Value to fill" },
      },
      required: ["selector", "value"],
    },
  },
  {
    name: ToolName.BrowserSelect,
    description: "Select an element on the page with Select tag using CSS selector",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for element to select" },
        value: { type: "string", description: "Value to select" },
      },
      required: ["selector", "value"],
    },
  },
  {
    name: ToolName.BrowserSelectText,
    description: "Select an element on the page with Select tag by its text content",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text content of the element to select" },
        value: { type: "string", description: "Value to select" },
      },
      required: ["text", "value"],
    },
  },
  {
    name: ToolName.BrowserHover,
    description: "Hover an element on the page using CSS selector",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for element to hover" },
      },
      required: ["selector"],
    },
  },
  {
    name: ToolName.BrowserHoverText,
    description: "Hover an element on the page by its text content",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text content of the element to hover" },
      },
      required: ["text"],
    },
  },
  {
    name: ToolName.BrowserEvaluate,
    description: "Execute JavaScript in the browser console",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "JavaScript code to execute" },
      },
      required: ["script"],
    },
  },
  {
    name: ToolName.BrowserGetLogs,
    description: "Retrieve browser console and/or network logs collected during the session",
    inputSchema: {
      type: "object",
      properties: {
        logTypes: {
          type: "array",
          items: { type: "string", enum: ["console", "network"] },
          description: "Types of logs to retrieve (default: both)"
        },
        clear: {
          type: "boolean",
          description: "Clear logs after retrieval (default: false)"
        },
        filter: {
          type: "object",
          properties: {
            console: {
              type: "object",
              properties: {
                types: {
                  type: "array",
                  items: { type: "string" },
                  description: "Filter by console types: log, warn, error, info, debug"
                },
                search: {
                  type: "string",
                  description: "Filter by text content (case-insensitive substring match)"
                }
              }
            },
            network: {
              type: "object",
              properties: {
                methods: {
                  type: "array",
                  items: { type: "string" },
                  description: "Filter by HTTP methods: GET, POST, PUT, DELETE, etc."
                },
                statusCodes: {
                  type: "array",
                  items: { type: "number" },
                  description: "Filter by specific status codes"
                },
                statusRange: {
                  type: "object",
                  properties: {
                    min: { type: "number" },
                    max: { type: "number" }
                  },
                  description: "Filter by status code range (e.g., {min: 400, max: 599} for errors)"
                },
                urlPattern: {
                  type: "string",
                  description: "Filter by URL pattern (regex)"
                },
                resourceTypes: {
                  type: "array",
                  items: { type: "string" },
                  description: "Filter by resource types: xhr, fetch, document, script, stylesheet, image"
                },
                failedOnly: {
                  type: "boolean",
                  description: "Show only failed requests"
                }
              }
            }
          },
          description: "Filters to apply to logs"
        },
        limit: {
          type: "number",
          description: "Maximum number of entries to return per log type (default: 100)"
        }
      },
      required: []
    }
  },
];

// Global state
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
const consoleLogs: ConsoleLogEntry[] = [];
const networkLogs: NetworkLogEntry[] = [];
const pendingRequests = new Map<string, { startTime: number; id: string }>();
const screenshots = new Map<string, string>();

// Helper function to attach page event listeners for logging
function attachPageListeners(targetPage: Page) {
  // Console listener
  targetPage.on("console", (msg) => {
    if (consoleLogs.length >= MAX_CONSOLE_LOGS) {
      consoleLogs.shift();
    }
    const entry: ConsoleLogEntry = {
      timestamp: Date.now(),
      type: msg.type(),
      text: msg.text()
    };
    consoleLogs.push(entry);
    server.notification({
      method: "notifications/resources/updated",
      params: { uri: "console://logs" },
    });
  });

  // Request listener - capture outgoing requests
  targetPage.on("request", (request) => {
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const key = request.url() + request.method();
    pendingRequests.set(key, { startTime: Date.now(), id });

    if (networkLogs.length >= MAX_NETWORK_LOGS) {
      networkLogs.shift();
    }
    const entry: NetworkLogEntry = {
      id,
      timestamp: Date.now(),
      type: 'request',
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType()
    };
    networkLogs.push(entry);
  });

  // Response listener - capture responses
  targetPage.on("response", (response) => {
    const request = response.request();
    const key = request.url() + request.method();
    const pending = pendingRequests.get(key);

    if (networkLogs.length >= MAX_NETWORK_LOGS) {
      networkLogs.shift();
    }
    const entry: NetworkLogEntry = {
      id: pending?.id || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      type: 'response',
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      status: response.status(),
      statusText: response.statusText(),
      duration: pending ? Date.now() - pending.startTime : undefined
    };
    networkLogs.push(entry);
    pendingRequests.delete(key);
  });

  // Request failed listener
  targetPage.on("requestfailed", (request) => {
    const key = request.url() + request.method();
    const pending = pendingRequests.get(key);
    const failure = request.failure();

    if (networkLogs.length >= MAX_NETWORK_LOGS) {
      networkLogs.shift();
    }
    const entry: NetworkLogEntry = {
      id: pending?.id || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      type: 'requestfailed',
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      errorText: failure?.errorText || 'Unknown error',
      duration: pending ? Date.now() - pending.startTime : undefined
    };
    networkLogs.push(entry);
    pendingRequests.delete(key);
  });
}

async function closeBrowser() {
  if (page) {
    try { await page.close(); } catch {}
    page = undefined;
  }
  if (context) {
    try { await context.close(); } catch {}
    context = undefined;
  }
  if (browser) {
    try { await browser.close(); } catch {}
    browser = undefined;
  }
  // Clear logs on browser close
  consoleLogs.length = 0;
  networkLogs.length = 0;
  pendingRequests.clear();
}

async function ensureBrowser() {
  if (!browser) {
    browser = await playwright.chromium.launch({ headless: false });
    context = await browser.newContext();
  }

  if (!page) {
    page = await context!.newPage();
    attachPageListeners(page);
  }

  return page!;
}

async function handleToolCall(name: ToolName, args: any): Promise<CallToolResult> {
  // Handle browser lifecycle tools first (don't need ensureBrowser)
  switch (name) {
    case ToolName.BrowserLaunch: {
      await closeBrowser();

      const browserType = args.browserType || "chromium";
      const headless = args.headless ?? false;
      const cdpEndpoint = args.cdpEndpoint;
      const debugPort = args.debugPort;

      // Validate CDP only works with chromium
      if (cdpEndpoint && browserType !== "chromium") {
        return {
          content: [{ type: "text", text: "CDP connection only works with chromium" }],
          isError: true
        };
      }

      // Validate debugPort cannot be used with cdpEndpoint
      if (debugPort && cdpEndpoint) {
        return {
          content: [{ type: "text", text: "debugPort cannot be used with cdpEndpoint (connecting to existing browser)" }],
          isError: true
        };
      }

      // Validate debugPort only works with chromium
      if (debugPort && browserType !== "chromium") {
        return {
          content: [{ type: "text", text: "debugPort only works with chromium browser type" }],
          isError: true
        };
      }

      try {
        if (cdpEndpoint) {
          browser = await chromium.connectOverCDP(cdpEndpoint);
          const contexts = browser.contexts();
          context = contexts.length > 0 ? contexts[0] : await browser.newContext();
        } else {
          const launchOptions: any = { headless };
          const launchArgs: string[] = [];

          if (args.windowPosition && !headless) {
            launchArgs.push(`--window-position=${args.windowPosition.x},${args.windowPosition.y}`);
          }

          // Add remote debugging port if specified
          if (debugPort) {
            launchArgs.push(`--remote-debugging-port=${debugPort}`);
          }

          if (launchArgs.length > 0) {
            launchOptions.args = launchArgs;
          }

          browser = await playwright[browserType as "chromium" | "firefox" | "webkit"].launch(launchOptions);

          const contextOptions: any = {};
          if (args.viewport) {
            contextOptions.viewport = args.viewport;
          }
          context = await browser.newContext(contextOptions);
        }

        page = await context.newPage();
        attachPageListeners(page);

        let responseText = cdpEndpoint
          ? `Connected to browser via CDP at ${cdpEndpoint}`
          : `Launched ${browserType} (headless: ${headless})`;

        if (debugPort) {
          responseText += ` with remote debugging on port ${debugPort}`;
        }

        return {
          content: [{ type: "text", text: responseText }],
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to launch browser: ${(error as Error).message}` }],
          isError: true
        };
      }
    }

    case ToolName.BrowserClose: {
      if (!browser) {
        return {
          content: [{ type: "text", text: "No browser is currently open" }],
          isError: false
        };
      }
      await closeBrowser();
      return {
        content: [{ type: "text", text: "Browser closed" }],
        isError: false
      };
    }
  }

  // For all other tools, ensure browser exists
  await ensureBrowser();

  switch (name) {
    case ToolName.BrowserNavigate:
      await page!.goto(args.url);
      return {
        content: [{
          type: "text",
            text: `Navigated to ${args.url}`,
          }],
        isError: false,
      };

    case ToolName.BrowserScreenshot: {
      const fullPage = (args.fullPage === 'true');

      const screenshot = await (args.selector ?
        page!.locator(args.selector).screenshot() :
        page!.screenshot({ fullPage }));
      const base64Screenshot = screenshot.toString('base64');

      if (!base64Screenshot) {
        return {
          content: [{
            type: "text",
            text: args.selector ? `Element not found: ${args.selector}` : "Screenshot failed",
          }],
          isError: true,
        };
      }

      screenshots.set(args.name, base64Screenshot);
      server.notification({
        method: "notifications/resources/list_changed",
      });

      return {
        content: [
          {
            type: "text",
            text: `Screenshot '${args.name}' taken`,
          } as TextContent,
          {
            type: "image",
              data: base64Screenshot,
              mimeType: "image/png",
            } as ImageContent,
          ],
        isError: false,
      };
    }

    case ToolName.BrowserClick:
      try {
        await page!.locator(args.selector).click();
        return {
          content: [{
            type: "text",
            text: `Clicked: ${args.selector}`,
          }],
          isError: false,
        };
      } catch (error) {
        if((error as Error).message.includes("strict mode violation")) {
            console.log("Strict mode violation, retrying on first element...");
            try {
                await page!.locator(args.selector).first().click();
                return {
                    content: [{
                        type: "text",
                        text: `Clicked: ${args.selector}`,
                    }],
                    isError: false,
                };
            } catch (error) {
                return {
                    content: [{
                        type: "text",
                        text: `Failed (twice) to click ${args.selector}: ${(error as Error).message}`,
                    }],
                    isError: true,
                };
            }
        }
        
        return {
          content: [{
            type: "text",
            text: `Failed to click ${args.selector}: ${(error as Error).message}`,
          }],
          isError: true,
        };
      }

    case ToolName.BrowserClickText:
      try {
        await page!.getByText(args.text).click();
        return {
          content: [{
            type: "text",
            text: `Clicked element with text: ${args.text}`,
          }],
          isError: false,
        };
      } catch (error) {
        if((error as Error).message.includes("strict mode violation")) {
            console.log("Strict mode violation, retrying on first element...");
            try {
                await page!.getByText(args.text).first().click();
                return {
                    content: [{
                        type: "text",
                        text: `Clicked element with text: ${args.text}`,
                    }],
                    isError: false,
                };
            } catch (error) {
                return {
                    content: [{
                        type: "text",
                        text: `Failed (twice) to click element with text ${args.text}: ${(error as Error).message}`,
                    }],
                    isError: true,
                };
            }
        }
        return {
          content: [{
            type: "text",
            text: `Failed to click element with text ${args.text}: ${(error as Error).message}`,
          }],
          isError: true,
        };
      }

    case ToolName.BrowserFill:
      try {
        await page!.locator(args.selector).pressSequentially(args.value, { delay: 100 });
        return {
          content: [{
            type: "text",
              text: `Filled ${args.selector} with: ${args.value}`,
            }],
          isError: false,
        };
      } catch (error) {
        if((error as Error).message.includes("strict mode violation")) {
            console.log("Strict mode violation, retrying on first element...");
            try {
                await page!.locator(args.selector).first().pressSequentially(args.value, { delay: 100 });
                return {
                    content: [{
                        type: "text",
                        text: `Filled ${args.selector} with: ${args.value}`,
                    }],
                    isError: false,
                };
            } catch (error) {
                return {
                    content: [{
                        type: "text",
                        text: `Failed (twice) to fill ${args.selector}: ${(error as Error).message}`,
                    }],
                    isError: true,
                };
            }
        }
        return {
          content: [{
            type: "text",
              text: `Failed to fill ${args.selector}: ${(error as Error).message}`,
            }],
          isError: true,
        };
      }

    case ToolName.BrowserSelect:
      try {
        await page!.locator(args.selector).selectOption(args.value);
        return {
          content: [{
            type: "text",
              text: `Selected ${args.selector} with: ${args.value}`,
            }],
          isError: false,
        };
      } catch (error) {
        if((error as Error).message.includes("strict mode violation")) {
            console.log("Strict mode violation, retrying on first element...");
            try {
                await page!.locator(args.selector).first().selectOption(args.value);
                return {
                    content: [{
                        type: "text",
                        text: `Selected ${args.selector} with: ${args.value}`,
                    }],
                    isError: false,
                };
            } catch (error) {
                return {
                    content: [{
                        type: "text",
                        text: `Failed (twice) to select ${args.selector}: ${(error as Error).message}`,
                    }],
                    isError: true,
                };
            }
        }
        return {
          content: [{
            type: "text",
              text: `Failed to select ${args.selector}: ${(error as Error).message}`,
            }],
          isError: true,
        };
      }

    case ToolName.BrowserSelectText:
      try {
        await page!.getByText(args.text).selectOption(args.value);
        return {
          content: [{
            type: "text",
            text: `Selected element with text ${args.text} with value: ${args.value}`,
          }],
          isError: false,
        };
      } catch (error) {
        if((error as Error).message.includes("strict mode violation")) {
            console.log("Strict mode violation, retrying on first element...");
            try {
                await page!.getByText(args.text).first().selectOption(args.value);
                return {
                    content: [{
                        type: "text",
                        text: `Selected element with text ${args.text} with value: ${args.value}`,
                    }],
                    isError: false,
                };
            } catch (error) {
                return {
                    content: [{
                        type: "text",
                        text: `Failed (twice) to select element with text ${args.text}: ${(error as Error).message}`,
                    }],
                    isError: true,
                };
            }
        }
        return {
          content: [{
            type: "text",
            text: `Failed to select element with text ${args.text}: ${(error as Error).message}`,
          }],
          isError: true,
        };
      }

    case ToolName.BrowserHover:
      try {
        await page!.locator(args.selector).hover();
        return {
          content: [{
            type: "text",
              text: `Hovered ${args.selector}`,
            }],
          isError: false,
        };
      } catch (error) {
        if((error as Error).message.includes("strict mode violation")) {
            console.log("Strict mode violation, retrying on first element...");
            try {
                await page!.locator(args.selector).first().hover();
                return {
                    content: [{
                        type: "text",
                        text: `Hovered ${args.selector}`,
                    }],
                    isError: false,
                };
            } catch (error) {
                return {
                    content: [{
                        type: "text",
                        text: `Failed to hover ${args.selector}: ${(error as Error).message}`,
                    }],
                    isError: true,
                };
            }
        }
        return {
          content: [{
            type: "text",
              text: `Failed to hover ${args.selector}: ${(error as Error).message}`,
            }],
          isError: true,
        };
      }

    case ToolName.BrowserHoverText:
      try {
        await page!.getByText(args.text).hover();
        return {
          content: [{
            type: "text",
            text: `Hovered element with text: ${args.text}`,
          }],
          isError: false,
        };
      } catch (error) {
        if((error as Error).message.includes("strict mode violation")) {
            console.log("Strict mode violation, retrying on first element...");
            try {
                await page!.getByText(args.text).first().hover();
                return {
                    content: [{
                        type: "text",
                        text: `Hovered element with text: ${args.text}`,
                    }],
                    isError: false,
                };
            } catch (error) {
                return {
                    content: [{
                        type: "text",
                        text: `Failed (twice) to hover element with text ${args.text}: ${(error as Error).message}`,
                    }],
                    isError: true,
                };
            }
        }
        return {
          content: [{
            type: "text",
            text: `Failed to hover element with text ${args.text}: ${(error as Error).message}`,
          }],
          isError: true,
        };
      }

    case ToolName.BrowserEvaluate:
      try {
        const result = await page!.evaluate((script) => {
          const logs: string[] = [];
          const originalConsole = { ...console };

          ['log', 'info', 'warn', 'error'].forEach(method => {
            (console as any)[method] = (...args: any[]) => {
              logs.push(`[${method}] ${args.join(' ')}`);
              (originalConsole as any)[method](...args);
            };
          });

          try {
            const result = eval(script);
            Object.assign(console, originalConsole);
            return { result, logs };
          } catch (error) {
            Object.assign(console, originalConsole);
            throw error;
          }
        }, args.script);

        return {
          content: [
            {
                type: "text",
                text: `Execution result:\n${JSON.stringify(result.result, null, 2)}\n\nConsole output:\n${result.logs.join('\n')}`,
              },
            ],
          isError: false,
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
              text: `Script execution failed: ${(error as Error).message}`,
            }],
          isError: true,
        };
      }

    case ToolName.BrowserGetLogs: {
      const logTypes: string[] = args.logTypes || ["console", "network"];
      const clear = args.clear ?? false;
      const filter = args.filter || {};
      const limit = args.limit ?? 100;

      const result: any = {};

      // Process console logs
      if (logTypes.includes("console")) {
        let filtered = [...consoleLogs];

        if (filter.console) {
          if (filter.console.types && filter.console.types.length > 0) {
            filtered = filtered.filter(log => filter.console.types.includes(log.type));
          }
          if (filter.console.search) {
            const searchLower = filter.console.search.toLowerCase();
            filtered = filtered.filter(log => log.text.toLowerCase().includes(searchLower));
          }
        }

        // Apply limit (most recent first)
        result.console = {
          total: consoleLogs.length,
          filtered: filtered.length,
          entries: filtered.slice(-limit).reverse()
        };
      }

      // Process network logs
      if (logTypes.includes("network")) {
        let filtered = [...networkLogs];

        if (filter.network) {
          if (filter.network.methods && filter.network.methods.length > 0) {
            const methods = filter.network.methods.map((m: string) => m.toUpperCase());
            filtered = filtered.filter(log => methods.includes(log.method));
          }
          if (filter.network.statusCodes && filter.network.statusCodes.length > 0) {
            filtered = filtered.filter(log =>
              log.status !== undefined && filter.network.statusCodes.includes(log.status)
            );
          }
          if (filter.network.statusRange) {
            const { min, max } = filter.network.statusRange;
            filtered = filtered.filter(log =>
              log.status !== undefined && log.status >= min && log.status <= max
            );
          }
          if (filter.network.urlPattern) {
            const regex = new RegExp(filter.network.urlPattern, 'i');
            filtered = filtered.filter(log => regex.test(log.url));
          }
          if (filter.network.resourceTypes && filter.network.resourceTypes.length > 0) {
            filtered = filtered.filter(log =>
              filter.network.resourceTypes.includes(log.resourceType)
            );
          }
          if (filter.network.failedOnly) {
            filtered = filtered.filter(log => log.type === 'requestfailed');
          }
        }

        // Apply limit (most recent first)
        result.network = {
          total: networkLogs.length,
          filtered: filtered.length,
          entries: filtered.slice(-limit).reverse()
        };
      }

      // Clear logs if requested
      if (clear) {
        if (logTypes.includes("console")) {
          consoleLogs.length = 0;
        }
        if (logTypes.includes("network")) {
          networkLogs.length = 0;
          pendingRequests.clear();
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }],
        isError: false
      };
    }

    default:
      return {
        content: [{
          type: "text",
            text: `Unknown tool: ${name}`,
          }],
        isError: true,
      };
  }
}

const server = new Server(
  {
    name: "automatalabs/playwright",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);


// Setup request handlers
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "console://logs",
      mimeType: "text/plain",
      name: "Browser console logs",
    },
    ...Array.from(screenshots.keys()).map(name => ({
      uri: `screenshot://${name}`,
      mimeType: "image/png",
      name: `Screenshot: ${name}`,
    })),
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri.toString();

  if (uri === "console://logs") {
    // Format console logs for resource read
    const formattedLogs = consoleLogs.map(log =>
      `[${log.type}] ${log.text}`
    ).join("\n");

    return {
      contents: [{
        uri,
        mimeType: "text/plain",
        text: formattedLogs,
      }],
    };
  }

  if (uri.startsWith("screenshot://")) {
    const name = uri.split("://")[1];
    const screenshot = screenshots.get(name);
    if (screenshot) {
      return {
        contents: [{
          uri,
          mimeType: "image/png",
          blob: screenshot,
        }],
      };
    }
  }

  throw new Error(`Resource not found: ${uri}`);
});



async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));
  
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleToolCall(request.params.name as ToolName, request.params.arguments ?? {})
  );
}

async function checkPlatformAndInstall() {
  const platform = os.platform();
  if (platform === "win32") {
    console.log("Installing MCP Playwright Server for Windows...");
    try {
      const configFilePath = path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
      
      let config: any;
      try {
        // Try to read existing config file
        const fileContent = await fs.readFile(configFilePath, 'utf-8');
        config = JSON.parse(fileContent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Create new config file with mcpServers object
          config = { mcpServers: {} };
          await fs.writeFile(configFilePath, JSON.stringify(config, null, 2), 'utf-8');
          console.log("Created new Claude config file");
        } else {
          console.error("Error reading Claude config file:", error);
          process.exit(1);
        }
      }

      // Ensure mcpServers exists
      if (!config.mcpServers) {
        config.mcpServers = {};
      }

      // Update the playwright configuration
      config.mcpServers.playwright = {
        command: "npx",
        args: ["-y", "@automatalabs/mcp-server-playwright"]
      };

      // Write the updated config back to file
      await fs.writeFile(configFilePath, JSON.stringify(config, null, 2), 'utf-8');
      console.log("✓ Successfully updated Claude configuration");
      
    } catch (error) {
      console.error("Error during installation:", error);
      process.exit(1);
    }
  } else if (platform === "darwin") {
    console.log("Installing MCP Playwright Server for macOS...");
    try {
      const configFilePath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      
      let config: any;
      try {
        // Try to read existing config file
        const fileContent = await fs.readFile(configFilePath, 'utf-8');
        config = JSON.parse(fileContent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Create new config file with mcpServers object
          config = { mcpServers: {} };
          await fs.writeFile(configFilePath, JSON.stringify(config, null, 2), 'utf-8');
          console.log("Created new Claude config file");
        } else {
          console.error("Error reading Claude config file:", error);
          process.exit(1);
        }
      }

      // Ensure mcpServers exists
      if (!config.mcpServers) {
        config.mcpServers = {};
      }

      // Update the playwright configuration
      config.mcpServers.playwright = {
        command: "npx",
        args: ["-y", "@automatalabs/mcp-server-playwright"]
      };

      // Write the updated config back to file
      await fs.writeFile(configFilePath, JSON.stringify(config, null, 2), 'utf-8');
      console.log("✓ Successfully updated Claude configuration");
      
    } catch (error) {
      console.error("Error during installation:", error);
      process.exit(1);
    }
  } else {
    console.error("Unsupported platform:", platform);
    process.exit(1);
  }
}

(async () => {
  try {
    // Parse args but continue with server if no command specified
    await yargs(hideBin(process.argv))
      .command('install', 'Install MCP-Server-Playwright dependencies', () => {}, async () => {
        await checkPlatformAndInstall();
        // Exit after successful installation
        process.exit(0);
      })
      .strict()
      .help()
      .parse();

    // If we get here, no command was specified, so run the server
    await runServer().catch(console.error);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
})();
