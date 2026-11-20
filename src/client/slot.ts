interface DsHReact {
  createElement(tag: string, props: Record<string, unknown> | null, ...children: unknown[]): unknown;
}

interface DsHSlotContext {
  readonly apiBase?: string;
  readonly config?: { readonly apiBase?: string };
  slots: {
    inject(slot: string, factory: () => unknown): void;
    register(descriptor: Record<string, unknown>, component: (props: { size?: number; apiBase?: string }) => unknown): unknown;
  };
}

interface DsHModuleLoader {
  load(definition: {
    id: string;
    factory(require: (name: string) => unknown): {
      inject: readonly string[];
      apply(ctx: DsHSlotContext): void;
    };
  }): void;
}

interface DsHHostWindow extends Window {
  __ModuleLoader__?: DsHModuleLoader;
  __DSH_API_BASE__?: string;
  __DSH_CLIENT__?: { readonly apiBase?: string };
  __DSH_CONFIG__?: { readonly apiBase?: string };
}

export type WorkbenchSlotView = "main" | "conversation";

export const WORKBENCH_IFRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-modals allow-downloads";
export const WORKBENCH_IFRAME_REFERRER_POLICY = "same-origin";
export const WORKBENCH_IFRAME_ALLOW = "clipboard-write";

function ensureTrailingSlash(url: URL): URL {
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

function readHostApiBase(explicitBase?: string): string | null {
  const candidates: Array<unknown> = [explicitBase];
  if (typeof window !== "undefined") {
    const hostWindow = window as DsHHostWindow;
    candidates.push(
      hostWindow.__DSH_CLIENT__?.apiBase,
      hostWindow.__DSH_API_BASE__,
      hostWindow.__DSH_CONFIG__?.apiBase,
    );
  }
  if (typeof document !== "undefined" && typeof document.querySelector === "function") {
    const meta = document.querySelector('meta[name="dsh-api-base"]');
    candidates.push(meta?.getAttribute?.("content"));
  }
  for (const raw of candidates) {
    if (typeof raw === "string" && raw.trim().length > 0) {
      return raw.trim();
    }
  }
  return null;
}

/**
 * Resolves the workbench iframe URL from DsH host metadata or `/api/zhizhang/workbench`
 * without breaking subpath deployments or falling prey to nested route `document.baseURI`
 * paths (DSH-17 / FE-23).
 */
export function resolveWorkbenchUrl(options?: {
  readonly view?: WorkbenchSlotView;
  readonly apiBase?: string;
}): URL {
  const hostBase = readHostApiBase(options?.apiBase);
  const originFallback =
    typeof location !== "undefined" && typeof location.origin === "string" && location.origin && location.origin !== "null"
      ? location.origin
      : typeof document !== "undefined" && typeof document.baseURI === "string" && document.baseURI
        ? document.baseURI
        : "http://localhost/";

  let url: URL;
  if (hostBase) {
    const resolvedBase = new URL(hostBase, originFallback);
    url = resolvedBase.pathname.endsWith("/api/zhizhang/workbench")
      ? resolvedBase
      : new URL("api/zhizhang/workbench", ensureTrailingSlash(resolvedBase));
  } else {
    const hasExplicitBaseTag =
      typeof document !== "undefined" &&
      typeof document.querySelector === "function" &&
      Boolean(document.querySelector("base[href]"));
    const hasLocationOrigin =
      typeof location !== "undefined" &&
      typeof location.origin === "string" &&
      location.origin.length > 0 &&
      location.origin !== "null";

    if (hasExplicitBaseTag && typeof document.baseURI === "string" && document.baseURI) {
      url = new URL("api/zhizhang/workbench", document.baseURI);
    } else if (hasLocationOrigin) {
      url = new URL("/api/zhizhang/workbench", location.origin);
    } else if (typeof document !== "undefined" && typeof document.baseURI === "string" && document.baseURI) {
      url = new URL("api/zhizhang/workbench", document.baseURI);
    } else {
      url = new URL("/api/zhizhang/workbench", "http://localhost/");
    }
  }

  if (options?.view === "conversation") {
    url.searchParams.set("view", "conversation");
  }
  return url;
}

export function createWorkbenchFrameProps(options?: {
  readonly view?: WorkbenchSlotView;
  readonly apiBase?: string;
}): Record<string, unknown> {
  const view: WorkbenchSlotView = options?.view === "conversation" ? "conversation" : "main";
  const source = resolveWorkbenchUrl({ view, apiBase: options?.apiBase });
  return {
    title: view === "conversation" ? "织章工作台（会话预览）" : "织章工作台",
    src: source.href,
    sandbox: WORKBENCH_IFRAME_SANDBOX,
    referrerPolicy: WORKBENCH_IFRAME_REFERRER_POLICY,
    allow: WORKBENCH_IFRAME_ALLOW,
    "data-zhizhang-view": view,
    style: { width: "100%", height: "100%", minHeight: "68vh", border: 0, display: "block" },
  };
}

if (typeof window !== "undefined" && (window as DsHHostWindow).__ModuleLoader__) {
  (window as DsHHostWindow).__ModuleLoader__!.load({
    id: "@zhizhang/dsh-workbench",
    factory(require) {
      const React = require("react") as DsHReact;

      function PanelIcon({ size }: { size?: number }) {
        return React.createElement(
          "span",
          { "aria-hidden": true, style: { fontSize: size, lineHeight: 1 } },
          "织",
        );
      }

      return {
        inject: ["slots"],
        apply(ctx) {
          const ctxApiBase = ctx.apiBase ?? ctx.config?.apiBase;

          function MainWorkbench(props?: { apiBase?: string }) {
            return React.createElement(
              "iframe",
              createWorkbenchFrameProps({ view: "main", apiBase: props?.apiBase ?? ctxApiBase }),
            );
          }

          function ConversationWorkbench(props?: { apiBase?: string }) {
            return React.createElement(
              "iframe",
              createWorkbenchFrameProps({ view: "conversation", apiBase: props?.apiBase ?? ctxApiBase }),
            );
          }

          ctx.slots.inject("main", () =>
            ctx.slots.register({ name: "main", key: "zhizhang.workbench" }, MainWorkbench),
          );
          ctx.slots.inject("sidebar.panellist", () =>
            ctx.slots.register(
              { name: "sidebar.panellist", id: "zhizhang.workbench", label: "织章", order: 20 },
              PanelIcon,
            ),
          );
          ctx.slots.inject("conversation.view", () =>
            ctx.slots.register(
              { name: "conversation.view", id: "zhizhang.workbench", label: "织章", order: 40 },
              ConversationWorkbench,
            ),
          );
        },
      };
    },
  });
}
