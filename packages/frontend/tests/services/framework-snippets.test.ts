import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FRAMEWORK_TABS,
  getStoredFramework,
  storeFramework,
  getPythonSnippets,
  getTypeScriptSnippets,
  getOpenClawSnippet,
  getOpenClawDisableSnippet,
  getCurlSnippet,
  getSnippetsForFramework,
  TOOLKIT_TABS,
  OPENAI_SDK_LANGS,
  SDK_LANG_TOGGLE,
  OPENAI_API_TOGGLE,
  getVercelPythonSnippet,
  getStoredToolkit,
  storeToolkit,
  getStoredOpenAILang,
  storeOpenAILang,
  getSnippetForToolkit,
  getLangForToolkit,
  getOpenClawWizardSnippet,
} from "../../src/services/framework-snippets";

describe("FRAMEWORK_TABS", () => {
  it("has four tabs", () => {
    expect(FRAMEWORK_TABS).toHaveLength(4);
  });

  it("contains python, typescript, openclaw, curl", () => {
    const ids = FRAMEWORK_TABS.map((t) => t.id);
    expect(ids).toEqual(["python", "typescript", "openclaw", "curl"]);
  });

  it("has display labels", () => {
    expect(FRAMEWORK_TABS[0].label).toBe("Python");
    expect(FRAMEWORK_TABS[1].label).toBe("TypeScript");
    expect(FRAMEWORK_TABS[2].label).toBe("OpenClaw");
    expect(FRAMEWORK_TABS[3].label).toBe("cURL");
  });
});

describe("TOOLKIT_TABS", () => {
  it("has five tabs", () => {
    expect(TOOLKIT_TABS).toHaveLength(5);
  });

  it("contains openai-sdk, anthropic-sdk, vercel-ai-sdk, langchain, curl", () => {
    const ids = TOOLKIT_TABS.map((t) => t.id);
    expect(ids).toEqual([
      "openai-sdk",
      "anthropic-sdk",
      "vercel-ai-sdk",
      "langchain",
      "curl",
    ]);
  });

  it("has display labels", () => {
    expect(TOOLKIT_TABS[0].label).toBe("OpenAI SDK");
    expect(TOOLKIT_TABS[1].label).toBe("Anthropic SDK");
    expect(TOOLKIT_TABS[2].label).toBe("Vercel AI SDK");
    expect(TOOLKIT_TABS[3].label).toBe("LangChain");
    expect(TOOLKIT_TABS[4].label).toBe("cURL");
  });

  it("has icons for openai, anthropic, vercel, and langchain", () => {
    expect(TOOLKIT_TABS[0].icon).toBe("/icons/providers/openai.svg");
    expect(TOOLKIT_TABS[1].icon).toBe("/icons/providers/anthropic.svg");
    expect(TOOLKIT_TABS[2].icon).toBe("/icons/vercel.svg");
    expect(TOOLKIT_TABS[3].icon).toBe("/icons/langchain.svg");
    expect(TOOLKIT_TABS[4].icon).toBeUndefined();
  });
});

describe("OPENAI_SDK_LANGS", () => {
  it("has two language options", () => {
    expect(OPENAI_SDK_LANGS).toHaveLength(2);
  });

  it("contains python and typescript", () => {
    expect(OPENAI_SDK_LANGS[0].id).toBe("python");
    expect(OPENAI_SDK_LANGS[0].label).toBe("Python");
    expect(OPENAI_SDK_LANGS[0].icon).toBe("/icons/python.svg");
    expect(OPENAI_SDK_LANGS[1].id).toBe("typescript");
    expect(OPENAI_SDK_LANGS[1].label).toBe("TypeScript");
    expect(OPENAI_SDK_LANGS[1].icon).toBe("/icons/typescript.svg");
  });
});

describe("SDK_LANG_TOGGLE", () => {
  it("is the same reference as OPENAI_SDK_LANGS", () => {
    expect(SDK_LANG_TOGGLE).toBe(OPENAI_SDK_LANGS);
  });

  it("has two language options", () => {
    expect(SDK_LANG_TOGGLE).toHaveLength(2);
  });
});

describe("OPENAI_API_TOGGLE", () => {
  it("defaults to Responses API before Chat Completions", () => {
    expect(OPENAI_API_TOGGLE).toEqual([
      { id: "responses", label: "Responses API" },
      { id: "chat-completions", label: "Chat Completions" },
    ]);
  });
});

describe("getVercelPythonSnippet", () => {
  it("returns a snippet with Vercel AI SDK Python title", () => {
    const snippet = getVercelPythonSnippet("http://localhost/v1", "mnfst_key");
    expect(snippet.title).toBe("Vercel AI SDK (Python)");
  });

  it("includes AI SDK Python client code", () => {
    const snippet = getVercelPythonSnippet("http://example.com/v1", "mnfst_abc");
    expect(snippet.code).toContain("from ai_sdk import AIClient");
    expect(snippet.code).toContain("http://example.com/v1");
    expect(snippet.code).toContain("mnfst_abc");
    expect(snippet.code).toContain('model="auto"');
  });
});

describe("getStoredFramework / storeFramework", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns python by default when nothing stored", () => {
    expect(getStoredFramework()).toBe("python");
  });

  it("returns stored framework after storeFramework", () => {
    storeFramework("typescript");
    expect(getStoredFramework()).toBe("typescript");
  });

  it("returns python for invalid stored value", () => {
    localStorage.setItem("manifest_setup_framework", "invalid");
    expect(getStoredFramework()).toBe("python");
  });

  it("handles localStorage errors gracefully for get", () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error("denied"); };
    expect(getStoredFramework()).toBe("python");
    Storage.prototype.getItem = orig;
  });

  it("handles localStorage errors gracefully for set", () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error("denied"); };
    expect(() => storeFramework("curl")).not.toThrow();
    Storage.prototype.setItem = orig;
  });
});

describe("getStoredToolkit / storeToolkit", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns openai-sdk by default when nothing stored", () => {
    expect(getStoredToolkit()).toBe("openai-sdk");
  });

  it("returns stored toolkit after storeToolkit", () => {
    storeToolkit("vercel-ai-sdk");
    expect(getStoredToolkit()).toBe("vercel-ai-sdk");
  });

  it("returns openai-sdk for invalid stored value", () => {
    localStorage.setItem("manifest_setup_toolkit", "invalid");
    expect(getStoredToolkit()).toBe("openai-sdk");
  });

  it("handles localStorage errors gracefully for get", () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error("denied"); };
    expect(getStoredToolkit()).toBe("openai-sdk");
    Storage.prototype.getItem = orig;
  });

  it("handles localStorage errors gracefully for set", () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error("denied"); };
    expect(() => storeToolkit("curl")).not.toThrow();
    Storage.prototype.setItem = orig;
  });
});

describe("getStoredOpenAILang / storeOpenAILang", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns python by default when nothing stored", () => {
    expect(getStoredOpenAILang()).toBe("python");
  });

  it("returns stored language after storeOpenAILang", () => {
    storeOpenAILang("typescript");
    expect(getStoredOpenAILang()).toBe("typescript");
  });

  it("returns python for invalid stored value", () => {
    localStorage.setItem("manifest_setup_openai_lang", "invalid");
    expect(getStoredOpenAILang()).toBe("python");
  });

  it("handles localStorage errors gracefully for get", () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error("denied"); };
    expect(getStoredOpenAILang()).toBe("python");
    Storage.prototype.getItem = orig;
  });

  it("handles localStorage errors gracefully for set", () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error("denied"); };
    expect(() => storeOpenAILang("typescript")).not.toThrow();
    Storage.prototype.setItem = orig;
  });
});

describe("getPythonSnippets", () => {
  it("returns two snippets", () => {
    const snippets = getPythonSnippets("http://localhost/v1", "mnfst_key");
    expect(snippets).toHaveLength(2);
  });

  it("includes LangChain snippet with base_url and api_key", () => {
    const snippets = getPythonSnippets("http://example.com/v1", "mnfst_abc");
    expect(snippets[0].title).toBe("LangChain");
    expect(snippets[0].code).toContain("http://example.com/v1");
    expect(snippets[0].code).toContain("mnfst_abc");
    expect(snippets[0].code).toContain("ChatOpenAI");
  });

  it("includes OpenAI SDK snippet", () => {
    const snippets = getPythonSnippets("http://example.com/v1", "mnfst_abc");
    expect(snippets[1].title).toBe("OpenAI Python SDK");
    expect(snippets[1].code).toContain("from openai import OpenAI");
    expect(snippets[1].code).toContain("http://example.com/v1");
    expect(snippets[1].code).toContain("client.responses.create");
    expect(snippets[1].code).toContain('input="Hello"');
    expect(snippets[1].code).not.toContain("chat.completions.create");
  });
});

describe("getTypeScriptSnippets", () => {
  it("returns two snippets", () => {
    const snippets = getTypeScriptSnippets("http://localhost/v1", "mnfst_key");
    expect(snippets).toHaveLength(2);
  });

  it("includes Vercel AI SDK snippet", () => {
    const snippets = getTypeScriptSnippets("http://example.com/v1", "mnfst_xyz");
    expect(snippets[0].title).toBe("Vercel AI SDK");
    expect(snippets[0].code).toContain("createOpenAI");
    expect(snippets[0].code).toContain("http://example.com/v1");
    expect(snippets[0].code).toContain("mnfst_xyz");
  });

  it("includes OpenAI TS SDK snippet", () => {
    const snippets = getTypeScriptSnippets("http://example.com/v1", "mnfst_xyz");
    expect(snippets[1].title).toBe("OpenAI TypeScript SDK");
    expect(snippets[1].code).toContain('import OpenAI from "openai"');
    expect(snippets[1].code).toContain("client.responses.create");
    expect(snippets[1].code).toContain('input: "Hello"');
    expect(snippets[1].code).not.toContain("chat.completions.create");
  });
});

describe("getClaudeCodeSettingsSnippet", () => {
  it("emits a paste-ready JSON block for ~/.claude/settings.json", async () => {
    const { getClaudeCodeSettingsSnippet } = await import(
      "../../src/services/framework-snippets"
    );
    const snippet = getClaudeCodeSettingsSnippet("http://localhost:38240/v1", "mnfst_key");
    // Strict-parse to make sure it's valid JSON and shaped correctly.
    const parsed = JSON.parse(snippet);
    expect(parsed).toEqual({
      model: "auto",
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:38240",
        ANTHROPIC_AUTH_TOKEN: "mnfst_key",
      },
    });
    // No node command, no shell artifacts — pure JSON.
    expect(snippet).not.toContain("node");
    expect(snippet).not.toContain("require");
  });
});

describe("getNanobotConfigSnippet", () => {
  it("emits a paste-ready JSON block for ~/.nanobot/config.json", async () => {
    const { getNanobotConfigSnippet } = await import(
      "../../src/services/framework-snippets"
    );
    const snippet = getNanobotConfigSnippet("http://localhost:38240/v1", "mnfst_key");
    // Strict-parse to make sure it's valid JSON and shaped correctly.
    const parsed = JSON.parse(snippet);
    expect(parsed).toEqual({
      agents: {
        defaults: {
          provider: "custom",
          model: "auto",
        },
      },
      providers: {
        custom: {
          apiKey: "mnfst_key",
          apiBase: "http://localhost:38240/v1",
        },
      },
    });
    // The OpenAI-compatible /v1 suffix must stay — nanobot's apiBase points
    // straight at chat completions, unlike the Anthropic-compatible Claude
    // Code env block.
    expect(snippet).toContain("http://localhost:38240/v1");
  });
});

describe("getOpenClawSnippet", () => {
  it("includes openclaw config set commands", () => {
    const snippet = getOpenClawSnippet("http://localhost/v1", "mnfst_key");
    expect(snippet).toContain("openclaw config set models.providers.manifest");
    expect(snippet).toContain("openclaw config set agents.defaults.model.primary manifest/auto");
    expect(snippet).toContain("openclaw gateway restart");
  });

  it("includes baseUrl and apiKey in JSON", () => {
    const snippet = getOpenClawSnippet("https://app.manifest.build/v1", "mnfst_test");
    expect(snippet).toContain("app.manifest.build/v1");
    expect(snippet).toContain("mnfst_test");
    expect(snippet).toContain("openai-completions");
    expect(snippet).not.toContain("openai-responses");
  });
});

describe("getOpenClawDisableSnippet", () => {
  it("includes unset commands and selected model", () => {
    const snippet = getOpenClawDisableSnippet("openai/gpt-4o");
    expect(snippet).toContain("openclaw config unset models.providers.manifest");
    expect(snippet).toContain("openclaw config set agents.defaults.model.primary openai/gpt-4o");
    expect(snippet).toContain("openclaw gateway restart");
  });

  it("includes placeholder when no model selected", () => {
    const snippet = getOpenClawDisableSnippet("<provider/model>");
    expect(snippet).toContain("<provider/model>");
  });
});

describe("getCurlSnippet", () => {
  it("returns one snippet", () => {
    const snippets = getCurlSnippet("http://localhost/v1", "mnfst_key");
    expect(snippets).toHaveLength(1);
  });

  it("includes curl command with Bearer token", () => {
    const snippets = getCurlSnippet("http://example.com/v1", "mnfst_abc");
    expect(snippets[0].title).toBe("cURL");
    expect(snippets[0].code).toContain("curl -X POST");
    expect(snippets[0].code).toContain("Bearer mnfst_abc");
    expect(snippets[0].code).toContain("http://example.com/v1/responses");
    expect(snippets[0].code).toContain('"input": "Hello"');
    expect(snippets[0].code).not.toContain("chat/completions");
  });
});

describe("getSnippetsForFramework", () => {
  it("returns python snippets for python", () => {
    const result = getSnippetsForFramework("python", "http://x/v1", "key");
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("LangChain");
  });

  it("returns typescript snippets for typescript", () => {
    const result = getSnippetsForFramework("typescript", "http://x/v1", "key");
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("Vercel AI SDK");
  });

  it("returns openclaw snippet for openclaw", () => {
    const result = getSnippetsForFramework("openclaw", "http://x/v1", "key");
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("OpenClaw CLI");
    expect(result[0].code).toContain("openclaw config set");
  });

  it("returns curl snippet for curl", () => {
    const result = getSnippetsForFramework("curl", "http://x/v1", "key");
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("cURL");
  });
});

describe("getSnippetForToolkit", () => {
  it("returns OpenAI Python SDK for openai-sdk with python lang", () => {
    const result = getSnippetForToolkit("openai-sdk", "http://x/v1", "key", "python");
    expect(result.title).toBe("OpenAI Python SDK");
    expect(result.code).toContain("from openai import OpenAI");
    expect(result.code).toContain("client.responses.create");
  });

  it("returns OpenAI TypeScript SDK for openai-sdk with typescript lang", () => {
    const result = getSnippetForToolkit("openai-sdk", "http://x/v1", "key", "typescript");
    expect(result.title).toBe("OpenAI TypeScript SDK");
    expect(result.code).toContain('import OpenAI from "openai"');
    expect(result.code).toContain("client.responses.create");
  });

  it("returns OpenAI Python Chat Completions when selected", () => {
    const result = getSnippetForToolkit(
      "openai-sdk",
      "http://x/v1",
      "key",
      "python",
      undefined,
      "chat-completions",
    );
    expect(result.title).toBe("Chat Completions");
    expect(result.code).toContain("client.chat.completions.create");
    expect(result.code).toContain('messages=[{"role": "user", "content": "Hello"}]');
    expect(result.code).not.toContain("client.responses.create");
  });

  it("returns OpenAI TypeScript Chat Completions when selected", () => {
    const result = getSnippetForToolkit(
      "openai-sdk",
      "http://x/v1",
      "key",
      "typescript",
      undefined,
      "chat-completions",
    );
    expect(result.title).toBe("Chat Completions");
    expect(result.code).toContain("client.chat.completions.create");
    expect(result.code).toContain('messages: [{ role: "user", content: "Hello" }]');
    expect(result.code).not.toContain("client.responses.create");
  });

  it("defaults to python for openai-sdk", () => {
    const result = getSnippetForToolkit("openai-sdk", "http://x/v1", "key");
    expect(result.title).toBe("OpenAI Python SDK");
  });

  it("strips trailing /v1 from base_url for the Anthropic Python SDK", () => {
    // The Anthropic SDK auto-appends /v1/messages — keeping /v1 in base_url
    // would produce /v1/v1/messages and a 404.
    const result = getSnippetForToolkit("anthropic-sdk", "http://x/v1", "key", "python");
    expect(result.code).toContain('base_url="http://x"');
    expect(result.code).not.toContain('base_url="http://x/v1"');
    expect(result.code).toContain("from anthropic import Anthropic");
    expect(result.code).toContain("client.messages.create");
  });

  it("strips trailing /v1 from baseURL for the Anthropic TypeScript SDK", () => {
    const result = getSnippetForToolkit("anthropic-sdk", "http://x/v1", "key", "typescript");
    expect(result.code).toContain('baseURL: "http://x"');
    expect(result.code).not.toContain('baseURL: "http://x/v1"');
    expect(result.code).toContain('import Anthropic from "@anthropic-ai/sdk"');
  });

  it("leaves the Anthropic base URL untouched when /v1 isn't present", () => {
    const result = getSnippetForToolkit("anthropic-sdk", "https://gw.example.com", "key", "python");
    expect(result.code).toContain('base_url="https://gw.example.com"');
  });

  it("returns Vercel AI SDK Python snippet by default", () => {
    const result = getSnippetForToolkit("vercel-ai-sdk", "http://x/v1", "key");
    expect(result.title).toBe("Vercel AI SDK (Python)");
    expect(result.code).toContain("from ai_sdk import AIClient");
  });

  it("returns Vercel AI SDK Python snippet with python lang", () => {
    const result = getSnippetForToolkit("vercel-ai-sdk", "http://x/v1", "key", "python");
    expect(result.title).toBe("Vercel AI SDK (Python)");
    expect(result.code).toContain("from ai_sdk import AIClient");
  });

  it("returns Vercel AI SDK TypeScript snippet with typescript lang", () => {
    const result = getSnippetForToolkit("vercel-ai-sdk", "http://x/v1", "key", "typescript");
    expect(result.title).toBe("Vercel AI SDK");
    expect(result.code).toContain("createOpenAI");
  });

  it("returns LangChain snippet for langchain", () => {
    const result = getSnippetForToolkit("langchain", "http://x/v1", "key");
    expect(result.title).toBe("LangChain");
    expect(result.code).toContain("ChatOpenAI");
  });

  it("returns cURL snippet for curl", () => {
    const result = getSnippetForToolkit("curl", "http://x/v1", "key");
    expect(result.title).toBe("cURL");
    expect(result.code).toContain("curl -X POST");
  });

  it("includes baseUrl and apiKey in snippet", () => {
    const result = getSnippetForToolkit("openai-sdk", "http://example.com/v1", "mnfst_abc");
    expect(result.code).toContain("http://example.com/v1");
    expect(result.code).toContain("mnfst_abc");
  });
});

describe("getLangForToolkit", () => {
  it("returns python for openai-sdk default", () => {
    expect(getLangForToolkit("openai-sdk")).toBe("python");
  });

  it("returns typescript for openai-sdk with typescript", () => {
    expect(getLangForToolkit("openai-sdk", "typescript")).toBe("typescript");
  });

  it("returns python for openai-sdk with python", () => {
    expect(getLangForToolkit("openai-sdk", "python")).toBe("python");
  });

  it("returns python for vercel-ai-sdk default", () => {
    expect(getLangForToolkit("vercel-ai-sdk")).toBe("python");
  });

  it("returns typescript for vercel-ai-sdk with typescript", () => {
    expect(getLangForToolkit("vercel-ai-sdk", "typescript")).toBe("typescript");
  });

  it("returns python for vercel-ai-sdk with python", () => {
    expect(getLangForToolkit("vercel-ai-sdk", "python")).toBe("python");
  });

  it("returns python for langchain", () => {
    expect(getLangForToolkit("langchain")).toBe("python");
  });

  it("returns bash for curl", () => {
    expect(getLangForToolkit("curl")).toBe("bash");
  });
});

describe("getOpenClawWizardSnippet", () => {
  it("returns the onboard command", () => {
    const snippet = getOpenClawWizardSnippet();
    expect(snippet).toBe("openclaw onboard");
  });
});

describe("customHeaders weaving", () => {
  const headers = { "x-manifest-tier": "premium" };

  it("python: getPythonSnippets adds default_headers to LangChain and OpenAI", () => {
    const [lc, openai] = getPythonSnippets("https://api.local/v1", "k", headers);
    expect(lc!.code).toContain('default_headers={"x-manifest-tier": "premium"}');
    expect(openai!.code).toContain('default_headers={"x-manifest-tier": "premium"}');
  });

  it("python: omitting customHeaders leaves the snippet unchanged", () => {
    const [lc, openai] = getPythonSnippets("https://api.local/v1", "k");
    expect(lc!.code).not.toContain("default_headers");
    expect(openai!.code).not.toContain("default_headers");
  });

  it("typescript: getTypeScriptSnippets uses headers for Vercel and defaultHeaders for OpenAI", () => {
    const [vercel, openai] = getTypeScriptSnippets("https://api.local/v1", "k", headers);
    expect(vercel!.code).toContain('headers: { "x-manifest-tier": "premium" }');
    expect(openai!.code).toContain('defaultHeaders: { "x-manifest-tier": "premium" }');
  });

  it("typescript: omitting customHeaders leaves the snippet unchanged", () => {
    const [vercel, openai] = getTypeScriptSnippets("https://api.local/v1", "k");
    expect(vercel!.code).not.toContain("headers:");
    expect(openai!.code).not.toContain("defaultHeaders");
  });

  it("vercel python: getVercelPythonSnippet adds default_headers", () => {
    const s = getVercelPythonSnippet("https://api.local/v1", "k", headers);
    expect(s.code).toContain('default_headers={"x-manifest-tier": "premium"}');
  });

  it("vercel python: omitting customHeaders leaves the snippet unchanged", () => {
    const s = getVercelPythonSnippet("https://api.local/v1", "k");
    expect(s.code).not.toContain("default_headers");
  });

  it("curl: getCurlSnippet adds -H flags for each header in declared order", () => {
    const s = getCurlSnippet("https://api.local/v1", "k", {
      "x-manifest-tier": "premium",
      "x-app-name": "billing",
    })[0];
    expect(s!.code).toContain("-H 'x-manifest-tier: premium'");
    expect(s!.code).toContain("-H 'x-app-name: billing'");
  });

  it("curl: empty customHeaders object is treated as 'no extra headers'", () => {
    const s = getCurlSnippet("https://api.local/v1", "k", {})[0];
    expect(s!.code).not.toContain("-H 'x-");
  });

  it("python: empty customHeaders object renders no default_headers kwarg", () => {
    // Guards the empty-entries branch in renderHeadersDict — passing `{}` must
    // not splice an empty `default_headers={}` into the snippet.
    const [lc, openai] = getPythonSnippets("https://api.local/v1", "k", {});
    expect(lc!.code).not.toContain("default_headers");
    expect(openai!.code).not.toContain("default_headers");
  });

  it("typescript: empty customHeaders object renders no headers/defaultHeaders prop", () => {
    const [vercel, openai] = getTypeScriptSnippets("https://api.local/v1", "k", {});
    expect(vercel!.code).not.toContain("headers:");
    expect(openai!.code).not.toContain("defaultHeaders");
  });

  it("vercel python: empty customHeaders object renders no default_headers kwarg", () => {
    const s = getVercelPythonSnippet("https://api.local/v1", "k", {});
    expect(s.code).not.toContain("default_headers");
  });

  it("getSnippetsForFramework forwards customHeaders to python", () => {
    const [lc] = getSnippetsForFramework("python", "https://api.local/v1", "k", headers);
    expect(lc!.code).toContain('default_headers={"x-manifest-tier": "premium"}');
  });

  it("getSnippetsForFramework forwards customHeaders to typescript", () => {
    const [vercel] = getSnippetsForFramework("typescript", "https://api.local/v1", "k", headers);
    expect(vercel!.code).toContain('headers: { "x-manifest-tier": "premium" }');
  });

  it("getSnippetsForFramework forwards customHeaders to curl", () => {
    const [c] = getSnippetsForFramework("curl", "https://api.local/v1", "k", headers);
    expect(c!.code).toContain("-H 'x-manifest-tier: premium'");
  });

  it("getSnippetsForFramework openclaw ignores customHeaders (CLI does not need them)", () => {
    const [s] = getSnippetsForFramework("openclaw", "https://api.local/v1", "k", headers);
    expect(s!.code).not.toContain("x-manifest-tier");
  });

  it("getSnippetForToolkit forwards customHeaders for openai-sdk python", () => {
    const s = getSnippetForToolkit("openai-sdk", "https://api.local/v1", "k", "python", headers);
    expect(s.code).toContain('default_headers={"x-manifest-tier": "premium"}');
  });

  it("getSnippetForToolkit forwards customHeaders for openai-sdk typescript", () => {
    const s = getSnippetForToolkit("openai-sdk", "https://api.local/v1", "k", "typescript", headers);
    expect(s.code).toContain('defaultHeaders: { "x-manifest-tier": "premium" }');
  });

  it("getSnippetForToolkit forwards customHeaders for vercel-ai-sdk python", () => {
    const s = getSnippetForToolkit("vercel-ai-sdk", "https://api.local/v1", "k", "python", headers);
    expect(s.code).toContain('default_headers={"x-manifest-tier": "premium"}');
  });

  it("getSnippetForToolkit forwards customHeaders for vercel-ai-sdk typescript", () => {
    const s = getSnippetForToolkit("vercel-ai-sdk", "https://api.local/v1", "k", "typescript", headers);
    expect(s.code).toContain('headers: { "x-manifest-tier": "premium" }');
  });

  it("getSnippetForToolkit forwards customHeaders for langchain", () => {
    const s = getSnippetForToolkit("langchain", "https://api.local/v1", "k", "python", headers);
    expect(s.code).toContain('default_headers={"x-manifest-tier": "premium"}');
  });

  it("getSnippetForToolkit forwards customHeaders for curl", () => {
    const s = getSnippetForToolkit("curl", "https://api.local/v1", "k", "python", headers);
    expect(s.code).toContain("-H 'x-manifest-tier: premium'");
  });
});
